# linux-wasm runtime notes (for Phase 2)

Source: `third_party/linux-wasm/runtime/` — `index.html` (page glue), `linux.js` (main-thread machine), `linux-worker.js` (one Worker per CPU/task), xterm.js (terminal), `server.py` (dev server).

## Boot flow (index.html)
1. Needs `crossOriginIsolated` (COOP `same-origin` + COEP `require-corp`) for `SharedArrayBuffer`/shared `WebAssembly.Memory`. `scripts/serve.mjs` sets these.
2. Fetches `vmlinux-<variant>.wasm` (compiled with `WebAssembly.compileStreaming`) and `initramfs-<variant>.cpio.gz` (raw `ArrayBuffer`). Filenames are hard-coded with the variant suffix (`wasm32_nommu` default, `?variant=wasm64_nommu`).
3. Calls `linux(worker_url, variant, vmlinux_module, boot_cmdline, initrd, log, console_write)` -> returns `{ key_input(str) }`.
   Cmdline: `maxcpus=3 nohz_full=0,2-63 rcu_nocbs=0,2-63 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0` (max 512 bytes).

## Workers / tasks
- One shared `WebAssembly.Memory` (shared, initial 30 pages, max 0x10000 pages) is created in `linux()` and posted to every Worker; vmlinux's `Module` is also posted (instantiated per worker against the same memory; the first instantiation initialises data/bss via an atomic flag).
- `make_cpu(0)` spawns the primary CPU Worker (`runner_type: primary_cpu`): it instantiates vmlinux, posts `start_primary {init_task}`, writes cmdline to `boot_command_line`, `memory.grow`s to hold the initrd, copies it in and sets `initrd_start/initrd_end` globals, then calls `_start()` (never returns).
- Workers cannot spawn Workers, so the kernel asks the main thread via messages (`linux.js: message_callbacks`):
  - `start_secondary {cpu, idle_task}` -> `make_cpu` (runner `secondary_cpu`, calls `_start_secondary`); `stop_secondary` terminates it.
  - `create_and_run_task {prev_task,new_task,name,user_executable}` -> `make_task` -> new Worker (`runner_type: task`) which calls `ret_from_fork`, then (if user task) compiles/instantiates the user `.wasm` and calls its `_start` (or `__libc_clone_callback` for clone()). So **every Linux task (thread/process) = one Web Worker**. `release_task` terminates it.
  - `serialize_tasks` / `lock_notify`/`lock_wait`: until SMP is up, tasks hand off the CPU through per-worker `Atomics.wait`/`notify` locks.
- exec(): kernel `wasm_load_executable(bin_start,bin_end,data_start,table_start)` compiles the ELF-replacement `.wasm` straight out of shared memory; `wasm_user_mode_tail(-1)` throws `Trap("reload_program")` to unwind the old user instance in the same Worker and start the new one. Signals use `__libc_handle_signal` the same way.
- Userland programs are PIC wasm modules (`-fPIC -shared`) sharing the single memory (NOMMU); syscalls go to `vmlinux.exports.wasm_syscall_{0..6}` imported directly.
- Other host callbacks (`host_callbacks` in linux-worker.js): clock (`wasm_cpu_clock_get_monotonic`), RNG (`wasm_random_get_bytes`), `wasm_panic`, `wasm_dump_stacktrace`.

## Console I/O
- stdout/kernel log: kernel hvc driver -> `wasm_driver_hvc_put(buf,count)` (worker) -> `postMessage {method:"console_write", message: <decoded utf8 string>}` -> main thread `console_write(str)` callback -> `term.write`. Kernel boot messages (console=hvc) and the tty output (ptys opened by init) arrive through this single stream.
- stdin: `os.key_input(str)` (called from `term.onData`) UTF-8 encodes and appends to main-thread `input_buffer`. The kernel *polls*: `wasm_driver_hvc_get(buf,count)` (worker) posts `console_read` and blocks on `Atomics.wait(console_read_messenger)`; the main thread copies up to `count` bytes straight into shared memory at `buf`, then stores the count and notifies. Returns 0 bytes if no input pending.
- No separate stderr / exit-code channel: everything is the terminal byte stream (tty line discipline, echo, CRLF, ANSI).
- `log(text)` callback receives host-side `[Runner ...]` diagnostics (not guest output).

## Initramfs
- `linux-wasm.sh build-initramfs`: prebuilt `patches/initramfs/initramfs-base.cpio` (device nodes) + busybox install tree + `/init` appended with `cpio -A`, gzipped.
- `/init`: mounts `/proc`, `/sys`, then `exec /sbin/init -s` (busybox init, which sets up a pty and a shell). Loaded by the primary-CPU worker as above (kernel unpacks it into ramfs, `root=/dev/ram0 rootfstype=ramfs`).
- Phase 2 option: extend the initramfs (more tools, custom `/init`, test scripts) by appending cpio entries, or pass different `init=`/`boot_cmdline`.

## Hooks for a headless `exec(cmd)` API
Everything needed is the `linux()` return value + the `console_write` callback, so no kernel changes are needed for a first version:
1. Run `linux.js` + `linux-worker.js` in a page (or Node `worker_threads` with a small shim for `Worker`/`postMessage`, `confirm`, `SharedArrayBuffer`; Node supports shared `WebAssembly.Memory` and `Atomics.wait` in workers) and supply a `console_write` that appends to a buffer instead of xterm.
2. `exec(cmd)`: write `cmd + "; echo __DONE_$id:$?\n"` via `os.key_input(...)`, accumulate `console_write` output until the sentinel line appears, strip echoed input/ANSI, parse exit code. Better: set `stty -echo` and `PS1=''` after boot and use a unique sentinel per command.
3. Wait for readiness: look for the shell prompt (or run `echo READY` after boot) in the `console_write` stream.
4. Cleaner alternatives for later: a custom `/init` that reads commands from a dedicated hvc/virtio channel, or an extra host callback pair (like `wasm_driver_hvc_put/get`) added to `host_callbacks` + kernel driver for a structured exec channel with separate stdout/stderr/exit status.
5. Files in/out: only via the initramfs (build time) or by echoing/`base64`-ing through the console until a better channel exists.
6. Caveats: `stop_secondary` for CPU 0 calls `confirm()` (browser-only, will throw in Node); `worker.onerror` rethrows on the main thread; input is only consumed when the kernel polls `hvc_get`, so very large pastes are slow.
