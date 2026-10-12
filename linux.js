// SPDX-License-Identifier: GPL-2.0-only

/// Create a Linux machine and run it.
const linux = async (worker_url, variant, vmlinux, boot_cmdline, initrd, log, console_write) => {
  const arch_bits = variant.startsWith("wasm32_") ? 32 : 64;
  const Ulong = (arch_bits == 32) ? Number : BigInt;

  /// Dict of online CPUs.
  const cpus = {};

  /// Dict of tasks.
  const tasks = {};

  /// Input buffer (from keyboard to tty).
  let input_buffer = new ArrayBuffer(0);

  /// Console output ordering. Every worker stamps its console chunks from this shared counter (the kernel holds the
  /// hvc lock across put_chars, so counter order is output order), but chunks posted by different workers can arrive
  /// here out of order. They are buffered and delivered by sequence number, as bytes, through one streaming decoder.
  const console_seq = new Int32Array(new SharedArrayBuffer(4));
  const console_decoder = new TextDecoder("utf-8");
  const console_pending = new Map();
  const console_stats = { chunks: 0, out_of_order: 0, gap_skips: 0 };
  let console_next = 0;

  /// /dev/winix channels: host-to-guest byte queues per channel id, and a shared flag per (id & 255) telling polling
  /// readers that a queue is non-empty (or closed). Guest-to-host bytes go to winix_handler.
  const winix_ready = new Int32Array(new SharedArrayBuffer(256 * 4));
  const winix_channels = new Map(); // id -> { queue: Uint8Array[], closed: bool }
  let winix_handler = { data: () => {}, close: () => {} };
  const winix_channel = (id) => {
    let c = winix_channels.get(id);
    if (!c) winix_channels.set(id, (c = { queue: [], closed: false }));
    return c;
  };
  const winix_flag = (id) => {
    let ready = 0;
    for (const [other, c] of winix_channels) {
      if ((other & 255) === (id & 255) && (c.queue.length > 0 || c.closed)) ready = 1;
    }
    Atomics.store(winix_ready, id & 255, ready);
  };
  let console_gap_timer = null;

  const console_flush = () => {
    while (console_pending.has(console_next)) {
      const data = console_pending.get(console_next);
      console_pending.delete(console_next);
      console_next++;
      console_write(console_decoder.decode(data, { stream: true }));
    }
    if (console_pending.size === 0) {
      clearTimeout(console_gap_timer);
      console_gap_timer = null;
    } else if (console_gap_timer === null) {
      // A worker died between taking a sequence number and posting: do not stall forever.
      console_gap_timer = setTimeout(() => {
        console_gap_timer = null;
        if (console_pending.size > 0) {
          console_next = Math.min(...console_pending.keys());
          console_stats.gap_skips++;
          console_flush();
        }
      }, 1000);
    }
  };

  const text_decoder = new TextDecoder("utf-8");
  const text_encoder = new TextEncoder();

  const lock_notify = (locks, lock, count) => {
    Atomics.store(locks._memory, locks[lock], 1);
    Atomics.notify(locks._memory, locks[lock], count || 1);
  };

  const lock_wait = (locks, lock) => {
    Atomics.wait(locks._memory, locks[lock], 0);
    Atomics.store(locks._memory, locks[lock], 0);
  };

  /// Callbacks from Web Workers (each one representing one task).
  const message_callbacks = {
    start_primary: (message) => {
      // CPU 0 has init_task which sits in static storage. After booting it becomes CPU 0's idle task. The runner will
      // in this special case tell us where it is so that we can register it.
      log("Starting cpu 0 with init_task " + message.init_task)
      tasks[message.init_task] = cpus[0];
    },

    start_secondary: (message) => {
      if (message.cpu <= 0) {
        throw new Error("Trying to start secondary cpu with ID <= 0");
      }

      log("Starting cpu " + message.cpu + " (" + message.idle_task + ")");
      make_cpu(message.cpu, message.idle_task);
    },

    stop_secondary: (message) => {
      if (message.cpu <= 0) {
        // If you arrive here, you probably got panic():ed with a broken stack.
        if (!confirm("Trying to stop secondary cpu with ID 0.\n\n" +
          "You probably got panic():ed with a broken stack. Continue?\n\n" +
          " (Say ok if you know what you are doing and want to catch the panic, otherwise cancel.)")) {
          throw new Error("Trying to stop secondary cpu with ID 0");
        }
      }

      if (cpus[message.cpu]) {
        log("[Main]: Stopping CPU " + message.cpu);
        cpus[message.cpu].worker.terminate();
        delete cpus[message.cpu];
      } else {
        log("[Main]: Tried to stop CPU " + message.cpu + " but it was already stopped (broken system)!");
      }
    },

    create_and_run_task: (message) => {
      // ret_from_fork will make sure the task switch finishes.
      make_task(message.prev_task, message.new_task, message.name, message.user_executable);
    },

    release_task: (message) => {
      kill_task(message.dead_task);
    },

    serialize_tasks: (message) => {
      // next_task was previously suspended, wake it up.

      // Tell the next task where we switched from, so that it can finish the task switch.
      tasks[message.next_task].last_task[0] = message.prev_task;

      tasks[message.prev_task].running = false;
      tasks[message.next_task].running = true;

      // Release the above write of last_task and wake up the task.
      lock_notify(tasks[message.next_task].locks, "serialize");

      // In case the task was dying, we're now done. prev_task will wait in serialize_me() but never be scheduled again.
      if (tasks[message.prev_task].kill) {
        kill_task(message.prev_task);
      }
    },

    console_read: (message, worker) => {
      const memory_u8 = new Uint8Array(memory.buffer);
      const buffer = new Uint8Array(input_buffer);

      const used = buffer.slice(0, message.count);
      memory_u8.set(used, message.buffer);

      const unused = buffer.slice(message.count);
      input_buffer = unused.buffer;

      // Tell the Worker that asked for input how many bytes (perhaps 0) were actually written.
      Atomics.store(message.console_read_messenger, 0, used.length);
      Atomics.notify(message.console_read_messenger, 0, 1);
    },

    winix_get: (message) => {
      const c = winix_channel(message.id);
      let n = 0;
      if (c.queue.length === 0 && c.closed) {
        n = -1;  // EOF
      } else {
        const memory_u8 = new Uint8Array(memory.buffer);
        while (c.queue.length > 0 && n < message.count) {
          const head = c.queue[0];
          const take = Math.min(head.length, message.count - n);
          memory_u8.set(head.subarray(0, take), message.buffer + n);
          n += take;
          if (take === head.length) c.queue.shift();
          else c.queue[0] = head.subarray(take);
        }
      }
      winix_flag(message.id);
      Atomics.store(message.messenger, 0, n);
      Atomics.notify(message.messenger, 0, 1);
    },

    winix_put: (message) => {
      winix_handler.data(message.id, message.data);
    },

    winix_close: (message) => {
      winix_channels.delete(message.id);
      winix_flag(message.id);
      winix_handler.close(message.id);
    },

    console_write: (message) => {
      console_stats.chunks++;
      if (message.seq !== console_next) {
        console_stats.out_of_order++;
      }
      console_pending.set(message.seq, message.data);
      console_flush();
    },

    log: (message) => {
      log(message.message);
    },
  };

  /// Memory shared between all CPUs.
  const memory = new WebAssembly.Memory({
    initial: Ulong(30), // TODO: extract this automatically from vmlinux.
    maximum: Ulong(0x10000), // Allow the full 32-bit address space to be allocated.
    shared: true,
    address: 'i' + arch_bits,
  });

  /**
   * Create and run one CPU in a background thread (a Web Worker).
   *
   * This will run boot code for the CPU, and then drop to run the idle task. For CPU 0 this involves booting the entire
   * system, including bringing up secondary CPUs at the end, while for secondary CPUs, this just means some
   * book-keeping before dropping into their own idle tasks.
   */
  const make_cpu = (cpu, idle_task) => {
    const options = {
      runner_type: (cpu == 0) ? "primary_cpu" : "secondary_cpu",
      idle_task: idle_task,
    };

    if (cpu == 0) {
      options.boot_cmdline = boot_cmdline;
      options.initrd = initrd;
      initrd = null;  // allow gc
    }

    // idle_task is undefined for cpu 0, we will know it first when start_primary notifies us.
    const name = "CPU " + cpu + " [boot+idle]" + (cpu != 0 ? " (" + idle_task + ")" : "");

    const runner = make_vmlinux_runner(name, options);
    cpus[cpu] = runner;
    if (cpu != 0) {
      tasks[idle_task] = runner; // For CPU 0, start_primary does this registration for us.
    }
  };

  /**
   * Create and run one task. This task has been switch_to():ed by the scheduler for the first time.
   *
   * In the beginning, all tasks are serialized and have to cooperate to schedule eachother, but after secondary CPUs
   * are brought up, they can run concurrently (and will effectively be managed by the Wasm host OS). While we are not
   * able to suspend them from JS, the host OS will do that.
   */
  const make_task = (prev_task, new_task, name, user_executable) => {
    const options = {
      runner_type: "task",
      prev_task: prev_task,
      new_task: new_task,
      user_executable: user_executable,
    };
    tasks[new_task] = make_vmlinux_runner(name + " (" + new_task + ")", options);
  };

  const kill_task = (dead_task) => {
    const task = tasks[dead_task];
    if (task.running) {
      // Case 1: current task is killing itself => we know that the reaped task is currently running (probably kthread).
      //
      // We need to delay killing the worker as it's still running. There is still some code for it to run, and
      // importantly, it needs to notify the next task to run on the CPU in serialize_me(). If the worker was
      // terminated before it was scheduled out, the dead task could deadlock its CPU on tasks[???].locks["serialize"].
      task.kill = true;
    } else {
      // Case 2: current task reaped another task => we know that the reaped task is not running. (kill == false).
      // Case 3: we get here from Case 1 as it eventually scheduled out, calling serialize_me(). (kill == true).
      task.worker.terminate();
      delete tasks[dead_task];
    }
  };

  /// Create a runner for vmlinux. It will run in a Web Worker and execute some specified code.
  const make_vmlinux_runner = (name, options) => {
    // Note: SharedWorker does not seem to allow WebAssembly Module or Memory instances posted.
    const worker = new Worker(worker_url, { name: name });

    let locks = {
      serialize: 0,
    };
    locks._memory = new Int32Array(new SharedArrayBuffer(Object.keys(locks).length * 4));

    // Store for last task when wasm_serialize() returns in switch_to(). Needed for each task, both normal ones and each
    // CPUs idle tasks (first called init_task (PID 0), not to be confused with init (PID 1) which is a normal task).
    const last_task = new Uint32Array(new SharedArrayBuffer(4));

    worker.onerror = (error) => {
      throw error;
    };

    worker.onmessage = (message_event) => {
      const data = message_event.data;
      message_callbacks[data.method](data, worker);
    };

    worker.onmessageerror = (error) => {
      throw error;
    };

    worker.postMessage({
      ...options,
      method: "init",
      console_seq: console_seq,
      winix_ready: winix_ready,
      variant: variant,
      vmlinux: vmlinux,
      memory: memory,
      locks: locks,
      last_task: last_task,
      runner_name: name,
    });

    return {
      worker: worker,
      locks: locks,
      last_task: last_task,
      running: true,
      kill: false,
    };
  };

  // Create the primary cpu, it will later on callback to us and we start secondaries.
  make_cpu(0);

  return {
    console_stats: console_stats,
    /// /dev/winix: set_handler({ data(id, bytes), close(id) }), send(id, bytes), close(id) (guest reads EOF).
    winix: {
      set_handler: (handler) => {
        winix_handler = handler;
      },
      send: (id, bytes) => {
        if (bytes.length === 0) return;
        winix_channel(id).queue.push(bytes);
        winix_flag(id);
      },
      close: (id) => {
        winix_channel(id).closed = true;
        winix_flag(id);
      },
    },
    key_input: (data) => {
      const key_buffer = text_encoder.encode(data);  // Possibly UTF-8 (up to 16 bits).

      // Append key_buffer to the end of input_buffer.
      const old_size = input_buffer.byteLength;
      input_buffer = input_buffer.transfer(old_size + key_buffer.byteLength);
      (new Uint8Array(input_buffer)).set(key_buffer, old_size);
    }
  };
};
