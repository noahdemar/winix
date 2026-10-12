// winix host API: boots the linux-wasm kernel in a hidden iframe and drives a BusyBox shell over the console.

const BOOT_CMDLINE =
  'maxcpus=3 nohz_full=0,2-63 rcu_nocbs=0,2-63 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0';
const PART_CHARS = 64000; // payload sent between acks
const CHUNK = 3000; // base64 chars per tty line (canonical limit is ~4095 bytes)
const READY_TIMEOUT_MS = 30000;
const BOOT_ATTEMPTS = 3;
const INTEGRITY_RETRIES = 2;
const BACKSTOP_MS = 15000; // host-side deadline beyond the in-guest timeout; resets the machine

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

const q = (s) => {
  s = String(s);
  if (/[\n\0]/.test(s)) throw new Error('newline/NUL not allowed here: ' + JSON.stringify(s));
  return "'" + s.replace(/'/g, "'\\''") + "'";
};

const toB64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

const fromB64 = (text) => {
  const bin = atob(text.replace(/[^A-Za-z0-9+/=]/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const withTail = (parts, tail) => ((parts[parts.length - 1] += tail), parts);

const sha256Hex = async (bytes) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((x) => x.toString(16).padStart(2, '0')).join('');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let counter = 0;
const newId = () => 'a' + (counter++).toString(36) + Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, '');

const assetCache = new Map();
const getAssets = (baseUrl, variant) => {
  const key = baseUrl + '|' + variant;
  if (!assetCache.has(key)) {
    const p = (async () => {
      const [module, initrd] = await Promise.all([
        WebAssembly.compileStreaming(fetch(new URL(`vmlinux-${variant}.wasm`, baseUrl))),
        fetch(new URL(`initramfs-${variant}.cpio.gz`, baseUrl)).then((r) => {
          if (!r.ok) throw new Error('failed to fetch initrd: ' + r.status);
          return r.arrayBuffer();
        }),
      ]);
      return { module, initrd };
    })();
    p.catch(() => assetCache.delete(key));
    assetCache.set(key, p);
  }
  return assetCache.get(key);
};

/// One booted guest: iframe + console line stream.
class Machine {
  constructor({ baseUrl, variant, onLog, cmdline, stats }) {
    this.cmdline = cmdline;
    this.stats = stats;
    this.baseUrl = baseUrl;
    this.variant = variant;
    this.onLog = onLog || (() => {});
    this.dead = null;
    this.sink = null; // (line) => void
    this.pending = null; // { reject }
    this.partial = '';
    this.onMessage = (e) => {
      if (e.source === this.iframe?.contentWindow && e.data?.winix === 'error') this.kill(new Error(e.data.message));
    };
  }

  kill(err) {
    if (!this.dead) this.dead = err;
    if (this.pending) {
      this.pending.reject(err);
      this.pending = null;
    }
  }

  destroy(reason = new Error('machine disposed')) {
    this.kill(reason);
    this.bankStats();
    window.removeEventListener('message', this.onMessage);
    this.iframe?.remove();
    this.iframe = null;
  }

  /// Adds this machine's console counters to the owner's totals (once).
  bankStats() {
    const c = this.os?.console_stats;
    if (!c || this.banked) return;
    this.banked = true;
    this.stats.consoleChunks += c.chunks;
    this.stats.consoleOutOfOrder += c.out_of_order;
    this.stats.consoleGapSkips += c.gap_skips;
  }

  consoleWrite(data) {
    this.partial += data;
    let i;
    while ((i = this.partial.indexOf('\n')) >= 0) {
      const line = this.partial.slice(0, i).replace(/\r$/, '');
      this.partial = this.partial.slice(i + 1);
      if (this.sink) this.sink(line);
    }
  }

  send(text) {
    this.os.key_input(text);
  }

  /// Resolves with sink-produced value; rejects on machine death or timeout.
  waitFor(setup, timeoutMs, what) {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => {
      const done = (fn, v) => {
        clearTimeout(timer);
        clearInterval(ticker);
        this.sink = null;
        this.pending = null;
        fn(v);
      };
      const timer = setTimeout(() => done(reject, new Error('timeout waiting for ' + what)), timeoutMs);
      let ticker;
      this.pending = { reject: (e) => done(reject, e) };
      ticker = setup({ resolve: (v) => done(resolve, v), setSink: (fn) => (this.sink = fn) });
    });
  }

  async start() {
    const { module, initrd } = await getAssets(this.baseUrl, this.variant);
    window.addEventListener('message', this.onMessage);
    const iframe = (this.iframe = document.createElement('iframe'));
    iframe.style.display = 'none';
    iframe.src = new URL('machine.html', this.baseUrl).href;
    const loaded = new Promise((r) => iframe.addEventListener('load', r, { once: true }));
    document.body.appendChild(iframe);
    await loaded;
    if (this.dead) throw this.dead;
    const win = iframe.contentWindow;
    const workerUrl = new URL('linux-worker.js', this.baseUrl).href;
    this.os = await win.linux(
      workerUrl, this.variant, module, this.cmdline, initrd.slice(0),
      (t) => this.onLog(t), (d) => this.consoleWrite(d));

    // Readiness: the interactive hush echoes input, so match the computed output, not the echoed text.
    await this.waitFor(({ resolve, setSink }) => {
      setSink((line) => line === '@@WINIX_2' && resolve());
      const send = () => this.send('echo @@WINIX_$((1+1))\n');
      send();
      return setInterval(send, 200);
    }, READY_TIMEOUT_MS, 'shell readiness');

    // Quiet the kernel, stop tty echo/CRLF, then feed a non-interactive sh from a pipe.
    this.send('dmesg -n 1; mkdir -p /tmp/.w /work; mknod /dev/null c 1 3; stty -echo -onlcr; cat | sh\n');
    await this.waitFor(({ resolve, setSink }) => {
      setSink((line) => line === '@@W init' && resolve());
      const send = () => this.send('echo @@W init\n');
      return setInterval(send, 300);
    }, READY_TIMEOUT_MS, 'shell setup');
  }

  /// Sends `lines` as one batch and collects marker-delimited sections.
  /// markers: array of marker names in order; returns { [name]: string[] } of lines preceding each marker.
  /// The first marker line may carry extra fields, returned as `fields`.
  async run(id, parts, markers, timeoutMs) {
    const pre = `@@W ${id} `;
    return this.waitFor(({ resolve, setSink }) => {
      const out = { fields: null, sections: {} };
      let idx = 0;
      let cur = [];
      let next = 0;
      // Parts are sent one at a time and acked, so the tty input queue never overflows.
      const sendNext = () => this.send(parts[next++] + (next < parts.length ? `echo "@@W ${id} A"
` : ''));
      setSink((line) => {
        if (line === pre + 'A') return sendNext();
        if (!line.startsWith(pre)) {
          if (idx > 0) cur.push(line);
          return;
        }
        const rest = line.slice(pre.length);
        const [name, ...fields] = rest.split(' ');
        if (name !== markers[idx]) return;
        if (idx === 0) out.fields = fields;
        else out.sections[markers[idx]] = cur;
        cur = [];
        if (++idx === markers.length) resolve(out);
      });
      sendNext();
      // hvc polling backs off to ~2s when idle; steady empty-line input keeps it at ~10ms
      return setInterval(() => this.send('\n'), 100);
    }, timeoutMs, 'command result');
  }

  /// Returns the shell lines that build /tmp/.w/<id>.b64, grouped into parts of roughly PART_CHARS.
  upload(id, bytes) {
    const b64 = toB64(bytes);
    const parts = [`: > /tmp/.w/${id}.b64\n`];
    for (let i = 0; i < b64.length; i += CHUNK) {
      if (parts[parts.length - 1].length > PART_CHARS) parts.push('');
      parts[parts.length - 1] += `printf %s '${b64.slice(i, i + CHUNK)}' >> /tmp/.w/${id}.b64\n`;
    }
    return parts;
  }
}

export class Winix {
  static async boot({ baseUrl = new URL('./', import.meta.url), variant = 'wasm32_nommu', onLog, cmdline = BOOT_CMDLINE } = {}) {
    const w = new Winix(new URL(baseUrl, document.baseURI).href, variant, onLog, cmdline);
    await w.#newMachine();
    return w;
  }

  #baseUrl;
  #variant;
  #onLog;
  #cmdline;
  #machine = null;
  #stats = { consoleChunks: 0, consoleOutOfOrder: 0, consoleGapSkips: 0, integrityRetries: 0 };
  #queue = Promise.resolve();
  #disposed = false;

  constructor(baseUrl, variant, onLog, cmdline) {
    this.#cmdline = cmdline;
    this.#baseUrl = baseUrl;
    this.#variant = variant;
    this.#onLog = onLog;
  }

  async #newMachine() {
    this.#machine?.destroy(new Error('machine reset'));
    // The kernel occasionally panics during boot; retry a few times.
    for (let attempt = 1; ; attempt++) {
      const m = (this.#machine = new Machine({ baseUrl: this.#baseUrl, variant: this.#variant, onLog: this.#onLog, cmdline: this.#cmdline, stats: this.#stats }));
      try {
        await m.start();
        return;
      } catch (e) {
        m.destroy(e);
        if (attempt >= BOOT_ATTEMPTS || this.#disposed) throw e;
      }
    }
  }

  #enqueue(fn) {
    if (this.#disposed) return Promise.reject(new Error('Winix disposed'));
    const p = this.#queue.then(() => {
      if (this.#disposed) throw new Error('Winix disposed');
      if (this.#machine.dead) throw new Error('machine is dead: ' + this.#machine.dead.message);
      return fn(this.#machine);
    });
    this.#queue = p.catch(() => {});
    return p;
  }

  exec(command, { cwd = '/work', env = {}, timeoutMs = 60000, maxOutputBytes = 1 << 20 } = {}) {
    return this.#enqueue(async (m) => {
      const id = newId();
      const secs = Math.max(1, Math.ceil(timeoutMs / 1000));
      let script = `cd ${q(cwd)} || exit 1\n`;
      for (const [k, v] of Object.entries(env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error('bad env name: ' + k);
        script += `export ${k}=${q(v)}\n`;
      }
      script += command + '\n';
      const f = `/tmp/.w/${id}`;
      // Output files stay around until the result has been verified.
      const fetchOutputs = (fid) =>
        `wc -c <${f}.o; wc -c <${f}.e; echo "@@W ${fid} S"; ` +
        `head -c ${maxOutputBytes} ${f}.o | base64; echo "@@W ${fid} O"; ` +
        `head -c ${maxOutputBytes} ${f}.e | base64; echo "@@W ${fid} E"\n`;
      const run =
        `base64 -d ${f}.b64 > ${f}.sh; timeout -s KILL ${secs} sh ${f}.sh </dev/null >${f}.o 2>${f}.e; ` +
        `echo "@@W ${id} X $?"; ` + fetchOutputs(id);
      const start = performance.now();
      let res;
      try {
        res = await m.run(id, withTail(m.upload(id, encoder.encode(script)), run), ['X', 'S', 'O', 'E'], timeoutMs + BACKSTOP_MS);
      } catch (e) {
        if (!/^timeout waiting/.test(e.message)) throw e;
        res = null;
      }
      const durationMs = performance.now() - start;
      if (!res) {
        await this.#newMachine();
        return { stdout: '', stderr: '', exitCode: -1, timedOut: true, truncated: false, durationMs };
      }
      const code = Number(res.fields[0]);
      let sections = res.sections;
      let out, err, osz, esz;
      for (let attempt = 0; ; attempt++) {
        [osz, esz] = sections.S.map(Number);
        try {
          out = fromB64(sections.O.join(''));
          err = fromB64(sections.E.join(''));
        } catch {
          out = err = null;
        }
        if (out && err && out.length === Math.min(osz, maxOutputBytes) && err.length === Math.min(esz, maxOutputBytes)) break;
        if (attempt >= INTEGRITY_RETRIES) throw new Error('output integrity check failed');
        this.#stats.integrityRetries++;
        const rid = newId();
        sections = (await m.run(rid, [fetchOutputs(rid)], ['S', 'O', 'E'], 30000)).sections;
      }
      try {
        m.send(`rm -f ${f}.*\n`); // fire and forget: tty input order keeps it ahead of the next op
      } catch {}
      return {
        stdout: decoder.decode(out),
        stderr: decoder.decode(err),
        exitCode: code,
        timedOut: code === 137 && durationMs >= timeoutMs * 0.9,
        truncated: osz > maxOutputBytes || esz > maxOutputBytes,
        durationMs,
      };
    });
  }

  writeFile(path, data) {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    return this.#enqueue(async (m) => {
      const expected = await sha256Hex(bytes);
      const dir = path.includes('/') ? path.replace(/\/[^/]*$/, '') || '/' : '.';
      for (let attempt = 0; ; attempt++) {
        const id = newId();
        const f = `/tmp/.w/${id}`;
        const cmd =
          `mkdir -p ${q(dir)} && base64 -d ${f}.b64 > ${q(path)}; echo "@@W ${id} X $?"; ` +
          `sha256sum ${q(path)}; echo "@@W ${id} S"; rm -f ${f}.*\n`;
        const res = await m.run(id, withTail(m.upload(id, bytes), cmd), ['X', 'S'], 60000 + bytes.length / 10);
        const got = (res.sections.S.find((l) => /^[0-9a-f]{64} /.test(l)) ?? '').slice(0, 64);
        if (res.fields[0] === '0' && got === expected) return;
        if (attempt >= INTEGRITY_RETRIES) {
          if (res.fields[0] !== '0') throw new Error(`writeFile ${path} failed (exit ${res.fields[0]})`);
          throw new Error(`writeFile ${path}: integrity check failed`);
        }
        this.#stats.integrityRetries++;
      }
    });
  }

  readFile(path, { encoding } = {}) {
    return this.#enqueue(async (m) => {
      for (let attempt = 0; ; attempt++) {
        const id = newId();
        const cmd =
          `[ -f ${q(path)} ]; echo "@@W ${id} X $?"; wc -c <${q(path)} 2>/dev/null; sha256sum ${q(path)} 2>/dev/null; ` +
          `echo "@@W ${id} S"; base64 ${q(path)} 2>/dev/null; echo "@@W ${id} O"\n`;
        const res = await m.run(id, [cmd], ['X', 'S', 'O'], 120000);
        if (res.fields[0] !== '0') throw new Error(`readFile ${path}: no such file`);
        const size = Number(res.sections.S[0]);
        const hash = (res.sections.S[1] ?? '').slice(0, 64);
        let bytes = null;
        try {
          bytes = fromB64(res.sections.O.join(''));
        } catch {}
        if (bytes && bytes.length === size && (await sha256Hex(bytes)) === hash) {
          return encoding === 'utf8' ? decoder.decode(bytes) : bytes;
        }
        if (attempt >= INTEGRITY_RETRIES) throw new Error(`readFile ${path}: integrity check failed`);
        this.#stats.integrityRetries++;
      }
    });
  }

  reset() {
    if (this.#disposed) return Promise.reject(new Error('Winix disposed'));
    const p = this.#queue.then(() => this.#newMachine());
    this.#queue = p.catch(() => {});
    return p;
  }

  /// Diagnostics: console chunks seen, chunks that arrived out of sequence, and integrity retries so far.
  stats() {
    const m = this.#machine;
    const live = !m || m.banked ? null : m.os?.console_stats;
    return {
      ...this.#stats,
      consoleChunks: this.#stats.consoleChunks + (live?.chunks ?? 0),
      consoleOutOfOrder: this.#stats.consoleOutOfOrder + (live?.out_of_order ?? 0),
      consoleGapSkips: this.#stats.consoleGapSkips + (live?.gap_skips ?? 0),
    };
  }

  dispose() {
    this.#disposed = true;
    this.#machine?.destroy();
  }
}
