// winix host API: boots the linux-wasm kernel in a hidden iframe and talks to the guest's winixd over /dev/winix,
// a binary channel (see guest/winix-proto.h for the frame format). Guest programs such as curl open their own
// channels; their HTTP requests are made with the page's fetch (or the `fetch` passed to boot()). Guest sockets are
// channels too, relayed by net.js through the `net` transport passed to boot().

import { GuestNet, SOCK_BIT } from './net.js';
export { wisp } from './net.js';
import { CHUNK, LIMITS, checkPath, cloneHostState, encodeArchive, hexOf, readArchive, sha256, validateManifest } from './session.js';

const BOOT_CMDLINE =
  'maxcpus=3 nohz_full=0,2-63 rcu_nocbs=0,2-63 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0 quiet';
const READY_TIMEOUT_MS = 30000;
const BOOT_ATTEMPTS = 3;
const BACKSTOP_MS = 15000; // host-side deadline beyond the in-guest timeout; resets the machine

const OP = {
  EXEC: 1, WRITE: 2, READ: 3, FETCH: 0x10,
  FS_LIST: 0x20, FS_READ: 0x21, FS_WRITE: 0x22, FS_NODE: 0x23, FS_META: 0x24, FS_REMOVE: 0x25,
};
const RP = {
  OUT: 0x81, EXIT: 0x82, OK: 0x83, ERR: 0x84, DATA: 0x85, READY: 0x86, RESP: 0x90, BODY: 0x91, END: 0x92,
  FS_ENTRY: 0x87,
};

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
  fstr() { return fatalDecoder.decode(this.bytes()); }
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
/// The kernel and initramfs for a baseUrl and variant, with SHA-256 identities of the exact fetched bytes.
const getAssets = (baseUrl, variant) => {
  const key = baseUrl + '|' + variant;
  if (!assetCache.has(key)) {
    const p = (async () => {
      const fetchBytes = async (url) => {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`failed to fetch ${url}: HTTP ${r.status}`);
        return r.arrayBuffer();
      };
      const [kernel, initrd] = await Promise.all([
        fetchBytes(new URL(`vmlinux-${variant}.wasm`, baseUrl)),
        fetchBytes(new URL(`initramfs-${variant}.cpio.gz`, baseUrl)),
      ]);
      const [module, kernelSha256, initrdSha256] = await Promise.all([
        WebAssembly.compile(kernel), sha256(kernel).then(hexOf), sha256(initrd).then(hexOf),
      ]);
      return { module, initrd, kernelSha256, initrdSha256 };
    })();
    p.catch(() => assetCache.delete(key));
    assetCache.set(key, p);
  }
  return assetCache.get(key);
};

/// One booted guest: iframe + channels to winixd and to guest clients (curl).
class Machine {
  constructor({ baseUrl, variant, onLog, onConsole, cmdline, fetch, net }) {
    Object.assign(this, { baseUrl, variant, cmdline, fetch, net });
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
    this.guestNet?.dispose();
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
    this.guestNet = attachChannels(this.os, {
      fetch: this.fetch, net: this.net, baseUrl: this.baseUrl, onFrame: (...a) => this.onFrame(...a),
    });
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
/// Socket channels go to a GuestNet relaying through the `net` transport (returned; without one, connections fail with
/// ENETUNREACH). Other frames go to onFrame(channelId, tag, op, reader).
export function attachChannels(os, { fetch: fetchFn = (...a) => fetch(...a), net = null, baseUrl = document.baseURI,
  onFrame = () => {} } = {}) {
  const channels = new Map(); // id -> Framer
  const guestNet = new GuestNet({ send: os.winix.send, close: os.winix.close }, net);
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
      if (id & SOCK_BIT) return guestNet.data(id, bytes);
      let c = channels.get(id);
      if (!c) channels.set(id, (c = new Framer((tag, op, r) => (op === OP.FETCH ? serveFetch(id, tag, r) : onFrame(id, tag, op, r)))));
      c.push(bytes);
    },
    close: (id) => (id & SOCK_BIT ? guestNet.close(id) : channels.delete(id)),
  });
  return guestNet;
}

/// A fetch for Winix.boot({ fetch }) that sends cross-origin requests through a proxy endpoint (such as
/// scripts/serve.mjs's /__proxy?url=), since most sites do not allow CORS.
export const proxyFetch = (prefix = '/__proxy?url=') => (url, init) =>
  new URL(url, location.href).origin === location.origin
    ? fetch(url, init)
    : fetch(prefix + encodeURIComponent(url), init);

// ---- session filesystem: each function runs inside one queued operation and uses Machine.request only ----

const KIND = { dir: 0x64, symlink: 0x6c, hardlink: 0x68 }; // NODE kinds: 'd', 'l', 'h'
const depthOf = (p) => p.split('/').length;
const fatalDecoder = new TextDecoder('utf-8', { fatal: true }); // filesystem names must be valid UTF-8, or fail
const readEntry = (r) => {
  const e = {
    path: r.fstr(), type: String.fromCharCode(r.u8()), mode: r.u32(), uid: r.u32(), gid: r.u32(),
    size: r.u32() + r.u32() * 2 ** 32, mtimeSec: r.fstr(), mtimeNsec: r.u32(), inode: r.fstr(), target: r.fstr(),
  };
  if (!'dlsfo'.includes(e.type) || e.type === '') throw new Error(`unknown entry type in the guest listing: ${e.type}`);
  return e;
};

/// Every entry under the guest root (regular, dir, symlink, and 'o' for excluded/mount/special), as readEntry objects.
const listFs = (m) => {
  const entries = [];
  return m.request(OP.FS_LIST, [], (op, r) => {
    if (op === RP.FS_ENTRY) {
      if (entries.length >= LIMITS.entries) throw new Error(`the filesystem has more than ${LIMITS.entries} entries`);
      entries.push(readEntry(r));
    } else if (op === RP.OK) return entries;
  }, 120000);
};

const readChunk = (m, path, offset, length) =>
  m.request(OP.FS_READ, [path, offset, length], (op, r) => (op === RP.DATA ? r.rest().slice() : undefined), 60000);

const writeChunk = (m, path, offset, truncate, bytes) =>
  m.request(OP.FS_WRITE, [path, offset, { u8: truncate ? 1 : 0 }, blob(bytes)], (op) => (op === RP.OK ? true : undefined), 60000);

const fsOp = (m, op, fields) => m.request(op, fields, (o) => (o === RP.OK ? true : undefined), 60000);

/// Reads, hashes and lists the whole filesystem. The inventory before and after must match, so a background writer
/// that changed anything during the save makes it fail instead of producing an inconsistent archive.
async function exportFs(m, { hostState, build, variant, report }) {
  const before = await listFs(m);
  const omitted = before.filter((e) => e.type === 'o').map((e) => ({ path: e.path, reason: e.target }));
  const live = before.filter((e) => e.type !== 'o').sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (live.length > LIMITS.entries) throw new Error(`the filesystem has more than ${LIMITS.entries} entries`);
  const canonical = new Map(); // inode -> canonical file path (first in sorted order)
  const entries = [];
  let payloadBytes = 0;
  for (const e of live) {
    let path;
    try {
      path = checkPath(e.path);
    } catch (err) {
      throw new Error(`cannot save ${JSON.stringify(e.path)}: ${err.message}`);
    }
    const base = { path, mode: e.mode, uid: e.uid, gid: e.gid, mtimeSec: e.mtimeSec, mtimeNsec: e.mtimeNsec };
    if (e.type === 'd') entries.push({ ...base, type: 'dir' });
    else if (e.type === 'l') entries.push({ ...base, type: 'symlink', target: e.target });
    else if (canonical.has(e.inode)) entries.push({ ...base, type: 'hardlink', target: canonical.get(e.inode) });
    else {
      canonical.set(e.inode, path);
      payloadBytes += e.size;
      if (payloadBytes > LIMITS.payload) throw new Error('the files total more than 512 MiB; this session cannot be saved');
      entries.push({ ...base, type: 'file', size: e.size, chunkHashes: [] });
    }
  }
  const payloadParts = [];
  const files = entries.filter((e) => e.type === 'file');
  const total = files.reduce((n, f) => n + f.size, 0);
  let bytesDone = 0;
  for (const [i, f] of files.entries()) {
    for (let off = 0; off < f.size; off += CHUNK) {
      const len = Math.min(CHUNK, f.size - off);
      const bytes = await readChunk(m, f.path, off, len);
      if (bytes.length !== len) throw new Error(`${f.path} changed during the save: stop background programs and save again`);
      f.chunkHashes.push(hexOf(await sha256(bytes)));
      payloadParts.push(bytes);
      bytesDone += len;
      report({ phase: 'export', filesDone: i, filesTotal: files.length, bytesDone, bytesTotal: total });
    }
  }
  const after = await listFs(m);
  const key = (x) => JSON.stringify([x.path, x.type, x.mode, x.uid, x.gid, x.size, x.mtimeSec, x.mtimeNsec, x.inode, x.target]);
  const a = before.map(key).sort(), b = after.map(key).sort();
  if (a.length !== b.length || a.some((k, i) => k !== b[i])) {
    throw new Error('the filesystem changed during the save: stop background programs and editors, then save again');
  }
  const manifest = {
    format: 'winix-session', version: 1, kind: 'filesystem', createdAt: new Date().toISOString(), variant, build,
    hostState, entries, omitted,
  };
  validateManifest(manifest);
  return { manifest, payloadParts };
}

/// Makes the guest's filesystem (outside excluded trees) equal to the session's. Runs on a freshly booted guest.
async function restoreFs(m, manifest, payload, report) {
  const current = (await listFs(m)).filter((e) => e.type !== 'o');
  const have = new Map(current.map((e) => [e.path, e]));
  const want = new Map(manifest.entries.map((e) => [e.path, e]));
  // A running program's file may be hard linked to other paths. Among current aliases of one inode that the backup
  // keeps as regular files, the first (sorted) path stays and the rest are unlinked; they are recreated as separate
  // files when their data is written. Aliases the backup makes hard links are unlinked and relinked after the data.
  const keeper = new Map();
  for (const e of [...current].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (e.type === 'f' && want.get(e.path)?.type === 'file' && !keeper.has(e.inode)) keeper.set(e.inode, e.path);
  }
  const drop = current.filter((e) => {
    const w = want.get(e.path);
    if (!w) return true;
    if (e.type === 'd') return w.type !== 'dir';
    if (e.type === 'l') return w.type !== 'symlink' || e.target !== w.target;
    if (e.type === 'f') return w.type !== 'file' || keeper.get(e.inode) !== e.path;
    return true;
  });
  drop.sort((a, b) => depthOf(b.path) - depthOf(a.path));
  for (const e of drop) {
    await fsOp(m, OP.FS_REMOVE, [e.path]);
    have.delete(e.path);
  }
  const offsets = new Map();
  let off = 0;
  for (const e of manifest.entries) if (e.type === 'file') (offsets.set(e.path, off), (off += e.size));
  const dirs = manifest.entries.filter((e) => e.type === 'dir').sort((a, b) => depthOf(a.path) - depthOf(b.path));
  for (const d of dirs) {
    if (d.path !== '/' && !have.has(d.path)) await fsOp(m, OP.FS_NODE, [{ u8: KIND.dir }, d.path, '']);
  }
  const files = manifest.entries.filter((e) => e.type === 'file');
  const total = off;
  let bytesDone = 0;
  for (const [i, f] of files.entries()) {
    const base = offsets.get(f.path);
    const cur = have.get(f.path);
    let same = !!cur && cur.type === 'f' && cur.size === f.size;
    for (let c = 0; same && c < f.chunkHashes.length; c++) {
      const len = Math.min(CHUNK, f.size - c * CHUNK);
      const bytes = await readChunk(m, f.path, c * CHUNK, len);
      same = bytes.length === len && hexOf(await sha256(bytes)) === f.chunkHashes[c];
    }
    if (!same) {
      if (f.size === 0) await writeChunk(m, f.path, 0, true, new Uint8Array(0));
      for (let c = 0; c * CHUNK < f.size; c++) {
        const len = Math.min(CHUNK, f.size - c * CHUNK);
        const piece = new Uint8Array(await payload.slice(base + c * CHUNK, base + c * CHUNK + len).arrayBuffer());
        await writeChunk(m, f.path, c * CHUNK, c === 0, piece);
      }
    }
    bytesDone += f.size;
    report({ phase: 'restore', filesDone: i + 1, filesTotal: files.length, bytesDone, bytesTotal: total });
  }
  // Links only after all data is in place, so that no write can go through a link.
  for (const e of manifest.entries) {
    if (e.type === 'hardlink' && !have.has(e.path)) await fsOp(m, OP.FS_NODE, [{ u8: KIND.hardlink }, e.path, e.target]);
    if (e.type === 'symlink' && !have.has(e.path)) await fsOp(m, OP.FS_NODE, [{ u8: KIND.symlink }, e.path, e.target]);
  }
  const meta = (e) => [e.path, e.mode, e.uid, e.gid, e.mtimeSec, e.mtimeNsec, { u8: e.type === 'symlink' ? 1 : 0 }];
  for (const e of manifest.entries) if (e.type !== 'dir') await fsOp(m, OP.FS_META, meta(e));
  for (const e of [...dirs].sort((a, b) => depthOf(b.path) - depthOf(a.path))) await fsOp(m, OP.FS_META, meta(e));
}

export class Winix {
  /// Options: baseUrl (where vmlinux/initramfs/linux.js live), variant, onLog (host diagnostics), onConsole (guest
  /// console text), cmdline, fetch (used for guest HTTP requests; default: the page's fetch), net (a transport for guest
  /// sockets such as wisp(url); default: none, so connections fail with ENETUNREACH).
  static async boot({ baseUrl = new URL('./', import.meta.url), variant = 'wasm32_nommu', onLog, onConsole,
    cmdline = BOOT_CMDLINE, fetch: fetchFn = (...a) => fetch(...a), net = null } = {}) {
    const w = new Winix({
      baseUrl: new URL(baseUrl, document.baseURI).href, variant, onLog, onConsole, cmdline, fetch: fetchFn, net,
    });
    await w.#newMachine();
    return w;
  }

  #opts;
  #machine = null;
  #queue = Promise.resolve();
  #disposed = false;
  #hostState = null; // plain JSON, owned by this instance; the getter and the save/restore copy it

  constructor(opts) {
    this.#opts = opts;
  }

  /// The host state saved with the session and restored with it (a copy; changing it changes nothing).
  get hostState() {
    return this.#hostState === null ? null : cloneHostState(this.#hostState);
  }

  /// Types text into the guest's terminal (the console), as a keyboard would. Not exec: nothing is queued.
  keyInput(text) {
    if (this.#disposed) throw new Error('Winix disposed');
    const m = this.#machine;
    if (!m || m.dead) throw new Error('machine is dead: ' + (m?.dead?.message ?? 'not started'));
    m.os.key_input(String(text));
  }

  /// Saves the guest's filesystem as a .winix session Blob. Queued like exec: the save runs after earlier operations and
  /// later operations wait for it. Options: hostState (plain JSON, default: this instance's hostState), onProgress.
  exportSession({ hostState = this.#hostState, onProgress } = {}) {
    const state = cloneHostState(hostState);
    const report = (p) => {
      try {
        onProgress?.(p);
      } catch (e) {
        console.error('onProgress callback failed', e);
      }
    };
    return this.#enqueue(async (m) => {
      const assets = await getAssets(this.#opts.baseUrl, this.#opts.variant);
      const build = { kernelSha256: assets.kernelSha256, initrdSha256: assets.initrdSha256 };
      const { manifest, payloadParts } = await exportFs(m, { hostState: state, build, variant: this.#opts.variant, report });
      return encodeArchive(manifest, payloadParts);
    });
  }

  /// Boots a new instance from a .winix session and restores its filesystem. Everything is validated before any machine
  /// starts; the archive's kernel and initramfs must match the ones at baseUrl. Returns the new instance; the caller's
  /// instances are never touched. Options: onProgress, plus the boot() options (baseUrl, variant, onConsole, fetch...).
  static async restoreSession(input, { onProgress, ...bootOptions } = {}) {
    const report = (p) => {
      try {
        onProgress?.(p);
      } catch (e) {
        console.error('onProgress callback failed', e);
      }
    };
    report({ phase: 'validate', filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 });
    const { manifest, payload } = await readArchive(input);
    const baseUrl = new URL(bootOptions.baseUrl ?? new URL('./', import.meta.url), document.baseURI).href;
    const variant = bootOptions.variant ?? 'wasm32_nommu';
    if (manifest.variant !== variant) {
      throw new Error(`this session is for ${manifest.variant}, not ${variant}`);
    }
    const assets = await getAssets(baseUrl, variant);
    if (assets.kernelSha256 !== manifest.build.kernelSha256 || assets.initrdSha256 !== manifest.build.initrdSha256) {
      throw new Error('this session was saved with a different winix build (kernel or initramfs differs); ' +
        'it cannot be restored here');
    }
    const w = await Winix.boot({ ...bootOptions, baseUrl, variant });
    try {
      await w.#enqueue((m) => restoreFs(m, manifest, payload, report));
      w.#hostState = cloneHostState(manifest.hostState ?? null);
      return w;
    } catch (e) {
      w.dispose();
      throw e;
    }
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

  /// Opens a TCP connection from the page to `port`, where a guest program listens (port forwarding). Returns
  /// { readable (a ReadableStream of Uint8Array), write(data), shutdown(), close() }; throws if nothing listens there.
  /// Not queued: it does not wait for exec calls.
  connect(port) {
    if (this.#disposed) throw new Error('Winix disposed');
    const m = this.#machine;
    if (!m || m.dead) throw new Error('machine is dead: ' + (m?.dead?.message ?? 'not started'));
    return m.guestNet.connectToGuest(port);
  }

  /// Sends an HTTP/1.1 request to a server listening on `port` in the guest and resolves to a Response. Options: method,
  /// headers (object), body (string or bytes), timeoutMs.
  async guestFetch(port, path = '/', { method = 'GET', headers = {}, body, timeoutMs = 30000 } = {}) {
    const c = this.connect(port);
    const bytes = body === undefined ? null : typeof body === 'string' ? encoder.encode(body) : body;
    let head = `${method} ${path} HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n`;
    for (const [k, v] of Object.entries(headers)) head += `${k}: ${v}\r\n`;
    if (bytes) head += `Content-Length: ${bytes.length}\r\n`;
    c.write(head + '\r\n');
    if (bytes) c.write(bytes);
    const timer = setTimeout(() => c.close(), timeoutMs);
    const chunks = [];
    try {
      for (const reader = c.readable.getReader(); ;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    } finally {
      clearTimeout(timer);
      c.close();
    }
    return parseHttpResponse(concat(chunks), method);
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

/// Parses a whole HTTP/1.x response (read until the server closed the connection) into a Response.
function parseHttpResponse(raw, method) {
  let i = 0;
  while (i + 3 < raw.length && !(raw[i] === 13 && raw[i + 1] === 10 && raw[i + 2] === 13 && raw[i + 3] === 10)) i++;
  if (i + 3 >= raw.length) throw new Error('guestFetch: incomplete HTTP response from the guest');
  const [statusLine, ...lines] = decoder.decode(raw.subarray(0, i)).split('\r\n');
  const m = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(statusLine);
  if (!m) throw new Error('guestFetch: bad status line: ' + statusLine.slice(0, 80));
  const headers = new Headers();
  for (const line of lines) {
    const k = line.indexOf(':');
    if (k > 0) headers.append(line.slice(0, k).trim(), line.slice(k + 1).trim());
  }
  let body = raw.subarray(i + 4);
  if (/\bchunked\b/i.test(headers.get('transfer-encoding') ?? '')) {
    const parts = [];
    for (let o = 0; ;) {
      const nl = body.indexOf(10, o);
      if (nl < 0) break;
      const size = parseInt(decoder.decode(body.subarray(o, nl)), 16);
      if (!(size > 0)) break;
      parts.push(body.subarray(nl + 1, nl + 1 + size));
      o = nl + 1 + size + 2;
    }
    body = concat(parts);
    headers.delete('transfer-encoding');
  } else if (headers.has('content-length')) {
    body = body.subarray(0, Number(headers.get('content-length')));
  }
  const status = Number(m[1]);
  const empty = method === 'HEAD' || status === 204 || status === 304 || status < 200;
  return new Response(empty ? null : body, { status: status < 200 ? 200 : status, statusText: m[2] ?? '', headers });
}

const concat = (cs) => {
  const out = new Uint8Array(cs.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of cs) (out.set(c, o), (o += c.length));
  return out;
};
