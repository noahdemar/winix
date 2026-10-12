// winix host API: boots the linux-wasm kernel in a hidden iframe and talks to the guest's winixd over /dev/winix,
// a binary channel (see guest/winix-proto.h for the frame format). Guest programs such as curl open their own
// channels; their HTTP requests are made with the page's fetch (or the `fetch` passed to boot()).

const BOOT_CMDLINE =
  'maxcpus=3 nohz_full=0,2-63 rcu_nocbs=0,2-63 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0 quiet';
const READY_TIMEOUT_MS = 30000;
const BOOT_ATTEMPTS = 3;
const BACKSTOP_MS = 15000; // host-side deadline beyond the in-guest timeout; resets the machine

const OP = { EXEC: 1, WRITE: 2, READ: 3, FETCH: 0x10 };
const RP = { OUT: 0x81, EXIT: 0x82, OK: 0x83, ERR: 0x84, DATA: 0x85, READY: 0x86, RESP: 0x90, BODY: 0x91, END: 0x92 };

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

/// Frame builder: u32 len | u32 tag | u8 op | payload (u32 ints, u32-length-prefixed strings/blobs).
const frame = (tag, op, ...fields) => {
  const parts = fields.map((f) => {
    if (typeof f === 'number') return new Uint8Array(new Uint32Array([f >>> 0]).buffer);
    if (f instanceof Uint8Array) return f;
    if (f && f.u8 !== undefined) return new Uint8Array([f.u8]);
    const s = typeof f === 'string' ? encoder.encode(f) : f.blob;
    const out = new Uint8Array(4 + s.length);
    new DataView(out.buffer).setUint32(0, s.length, true);
    out.set(s, 4);
    return out;
  });
  const len = 5 + parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(4 + len);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, len, true);
  dv.setUint32(4, tag, true);
  out[8] = op;
  let o = 9;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};
const blob = (b) => ({ blob: b });

/// Payload reader for one received frame.
class Reader {
  constructor(bytes) {
    this.b = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.o = 0;
  }
  u8() { return this.b[this.o++]; }
  u32() { const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
  i32() { const v = this.dv.getInt32(this.o, true); this.o += 4; return v; }
  bytes() { const n = this.u32(); const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; }
  str() { return decoder.decode(this.bytes()); }
  rest() { return this.b.subarray(this.o); }
}

/// Reassembles frames from a channel's byte stream.
class Framer {
  constructor(onFrame) {
    this.buf = new Uint8Array(0);
    this.onFrame = onFrame;
  }
  push(bytes) {
    const b = new Uint8Array(this.buf.length + bytes.length);
    b.set(this.buf);
    b.set(bytes, this.buf.length);
    let o = 0;
    while (b.length - o >= 4) {
      const len = new DataView(b.buffer, o).getUint32(0, true);
      if (b.length - o - 4 < len) break;
      const body = b.subarray(o + 4, o + 4 + len);
      const dv = new DataView(body.buffer, body.byteOffset);
      this.onFrame(dv.getUint32(0, true), body[4], new Reader(body.subarray(5)));
      o += 4 + len;
    }
    this.buf = b.slice(o);
  }
}

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

/// One booted guest: iframe + channels to winixd and to guest clients (curl).
class Machine {
  constructor({ baseUrl, variant, onLog, onConsole, cmdline, fetch }) {
    Object.assign(this, { baseUrl, variant, cmdline, fetch });
    this.onLog = onLog || (() => {});
    this.onConsole = onConsole || (() => {});
    this.dead = null;
    this.daemon = null; // winixd's channel id
    this.pending = new Map(); // tag -> { onFrame(op, reader), reject }
    this.nextTag = 1;
    this.ready = null;
    this.onMessage = (e) => {
      if (e.source === this.iframe?.contentWindow && e.data?.winix === 'error') this.kill(new Error(e.data.message));
    };
  }

  kill(err) {
    if (!this.dead) this.dead = err;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.ready?.reject(err);
  }

  destroy(reason = new Error('machine disposed')) {
    this.kill(reason);
    window.removeEventListener('message', this.onMessage);
    this.iframe?.remove();
    this.iframe = null;
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
    const ready = new Promise((resolve, reject) => (this.ready = { resolve, reject }));
    const timer = setTimeout(() => this.kill(new Error('timeout waiting for winixd')), READY_TIMEOUT_MS);
    this.os = await iframe.contentWindow.linux(
      new URL('linux-worker.js', this.baseUrl).href, this.variant, module, this.cmdline, initrd.slice(0),
      (t) => this.onLog(t), (d) => this.onConsole(d));
    attachChannels(this.os, { fetch: this.fetch, baseUrl: this.baseUrl, onFrame: (...a) => this.onFrame(...a) });
    try {
      await ready;
    } finally {
      clearTimeout(timer);
    }
  }

  onFrame(id, tag, op, r) {
    if (op === RP.READY) {
      this.daemon = id;
      this.ready?.resolve();
    } else if (id === this.daemon) {
      this.pending.get(tag)?.onFrame(op, r);
    }
  }

  /// Sends a request to winixd; onFrame(op, reader) returns a value to resolve with, or undefined to keep waiting.
  request(op, fields, onFrame, timeoutMs) {
    if (this.dead) return Promise.reject(this.dead);
    const tag = this.nextTag++;
    return new Promise((resolve, reject) => {
      const done = (fn, v) => {
        clearTimeout(timer);
        this.pending.delete(tag);
        fn(v);
      };
      const timer = setTimeout(() => done(reject, new Error('timeout waiting for winixd')), timeoutMs);
      this.pending.set(tag, {
        reject: (e) => done(reject, e),
        onFrame: (op, r) => {
          if (op === RP.ERR) {
            const errno = r.i32();
            return done(reject, Object.assign(new Error(r.str()), { errno }));
          }
          try {
            const v = onFrame(op, r);
            if (v !== undefined) done(resolve, v);
          } catch (e) {
            done(reject, e);
          }
        },
      });
      this.os.winix.send(this.daemon, frame(tag, op, ...fields));
    });
  }

}

/// Routes the /dev/winix channels of a booted linux() instance. HTTP requests from guest programs (curl, apt) are
/// made with `fetch`; winix://path URLs resolve against baseUrl, where the package repository (pkgs/) is served.
/// Other frames go to onFrame(channelId, tag, op, reader).
export function attachChannels(os, { fetch: fetchFn = (...a) => fetch(...a), baseUrl = document.baseURI, onFrame = () => {} } = {}) {
  const channels = new Map(); // id -> Framer
  const serveFetch = async (id, tag, r) => {
    const send = (op, ...f) => os.winix.send(id, frame(tag, op, ...f));
    try {
      r.u8(); // flags (redirects are always followed)
      const method = r.str(), url = r.str(), headerText = r.str(), body = r.bytes();
      const headers = new Headers();
      for (const line of headerText.split('\n')) {
        const i = line.indexOf(':');
        if (i > 0) headers.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
      }
      const target = url.startsWith('winix://') ? new URL(url.slice('winix://'.length), baseUrl).href : url;
      const res = await fetchFn(target, {
        method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : body.slice(), redirect: 'follow',
      });
      let hs = '';
      res.headers.forEach((v, k) => (hs += `${k}: ${v}\n`));
      send(RP.RESP, res.status, res.statusText, hs.replace(/\n$/, ''));
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!channels.has(id)) return reader.cancel(); // the guest closed the channel
          send(RP.BODY, value);
        }
      }
      send(RP.END);
    } catch (e) {
      send(RP.ERR, 0, `fetch failed: ${e.message || e} (network error, or the server does not allow CORS; ` +
        'pass a proxying fetch, such as proxyFetch())');
    }
  };
  os.winix.set_handler({
    data: (id, bytes) => {
      let c = channels.get(id);
      if (!c) channels.set(id, (c = new Framer((tag, op, r) => (op === OP.FETCH ? serveFetch(id, tag, r) : onFrame(id, tag, op, r)))));
      c.push(bytes);
    },
    close: (id) => channels.delete(id),
  });
}

/// A fetch for Winix.boot({ fetch }) that sends cross-origin requests through a proxy endpoint (such as
/// scripts/serve.mjs's /__proxy?url=), since most sites do not allow CORS.
export const proxyFetch = (prefix = '/__proxy?url=') => (url, init) =>
  new URL(url, location.href).origin === location.origin
    ? fetch(url, init)
    : fetch(prefix + encodeURIComponent(url), init);

export class Winix {
  /// Options: baseUrl (where vmlinux/initramfs/linux.js live), variant, onLog (host diagnostics), onConsole (guest
  /// console text), cmdline, fetch (used for guest HTTP requests; default: the page's fetch).
  static async boot({ baseUrl = new URL('./', import.meta.url), variant = 'wasm32_nommu', onLog, onConsole,
    cmdline = BOOT_CMDLINE, fetch: fetchFn = (...a) => fetch(...a) } = {}) {
    const w = new Winix({ baseUrl: new URL(baseUrl, document.baseURI).href, variant, onLog, onConsole, cmdline, fetch: fetchFn });
    await w.#newMachine();
    return w;
  }

  #opts;
  #machine = null;
  #queue = Promise.resolve();
  #disposed = false;

  constructor(opts) {
    this.#opts = opts;
  }

  async #newMachine() {
    this.#machine?.destroy(new Error('machine reset'));
    // The kernel occasionally panics during boot; retry a few times.
    for (let attempt = 1; ; attempt++) {
      const m = (this.#machine = new Machine(this.#opts));
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

  /// Runs `command` with sh -c. Resolves { stdout, stderr, exitCode, timedOut, truncated, durationMs }.
  exec(command, { cwd = '/work', env = {}, timeoutMs = 60000, maxOutputBytes = 1 << 20 } = {}) {
    return this.#enqueue(async (m) => {
      let script = '';
      for (const [k, v] of Object.entries(env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error('bad env name: ' + k);
        script += `export ${k}='${String(v).replace(/'/g, "'\\''")}'\n`;
      }
      script += command;
      const chunks = [[], []];
      const start = performance.now();
      let res;
      try {
        res = await m.request(OP.EXEC, [Math.max(1, timeoutMs), maxOutputBytes, cwd, script], (op, r) => {
          if (op === RP.OUT) chunks[r.u8() - 1].push(r.rest().slice());
          else if (op === RP.EXIT) return { code: r.i32(), timedOut: r.u8() === 1, outTotal: r.u32(), errTotal: r.u32() };
        }, timeoutMs + BACKSTOP_MS);
      } catch (e) {
        if (!/^timeout waiting/.test(e.message)) throw e;
        await this.#newMachine(); // winixd stopped answering
        return { stdout: '', stderr: '', exitCode: -1, timedOut: true, truncated: false, durationMs: performance.now() - start };
      }
      const join = (cs) => decoder.decode(concat(cs));
      return {
        stdout: join(chunks[0]),
        stderr: join(chunks[1]),
        exitCode: res.code,
        timedOut: res.timedOut,
        truncated: res.outTotal > maxOutputBytes || res.errTotal > maxOutputBytes,
        durationMs: performance.now() - start,
      };
    });
  }

  /// Writes a file (string as UTF-8, or bytes), creating parent directories.
  writeFile(path, data, { mode = 0o644 } = {}) {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    return this.#enqueue((m) =>
      m.request(OP.WRITE, [mode, path, blob(bytes)], (op) => (op === RP.OK ? true : undefined), 60000 + bytes.length / 10)
        .then(() => undefined, (e) => { throw new Error(`writeFile ${path}: ${e.message}`); }));
  }

  /// Reads a file: Uint8Array, or a string with { encoding: 'utf8' }.
  readFile(path, { encoding } = {}) {
    return this.#enqueue((m) =>
      m.request(OP.READ, [path], (op, r) => (op === RP.DATA ? r.rest().slice() : undefined), 120000).then(
        (bytes) => (encoding === 'utf8' ? decoder.decode(bytes) : bytes),
        (e) => { throw new Error(`readFile ${path}: ${e.message}`); }));
  }

  /// Replaces the machine with a freshly booted one (the filesystem is lost).
  reset() {
    if (this.#disposed) return Promise.reject(new Error('Winix disposed'));
    const p = this.#queue.then(() => this.#newMachine());
    this.#queue = p.catch(() => {});
    return p;
  }

  dispose() {
    this.#disposed = true;
    this.#machine?.destroy();
  }
}

const concat = (cs) => {
  const out = new Uint8Array(cs.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of cs) (out.set(c, o), (o += c.length));
  return out;
};
