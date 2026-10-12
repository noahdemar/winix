// Session archives (.winix): a filesystem snapshot of a winix machine, gzip-compressed.
//
// Uncompressed layout: "WINIXS01" | u32LE manifest length | 32 raw bytes SHA-256 of the manifest | manifest (UTF-8
// JSON) | regular-file bytes, in manifest entry order. Checksums detect corruption; they do not prove authenticity,
// so only restore backups you trust. Nothing here runs guest code: the archive is validated before any machine boots.

export const MAGIC = 'WINIXS01';
export const CHUNK = 256 * 1024;
export const LIMITS = {
  archive: 512 * 1024 * 1024,   // compressed input, compressed output, and total regular-file payload
  payload: 512 * 1024 * 1024,
  manifest: 32 * 1024 * 1024,
  entries: 100000,
  path: 4095,   // UTF-8 bytes
  name: 255,    // UTF-8 bytes per path component
  depth: 64,    // hostState nesting
  reason: 256,  // UTF-8 bytes of an omitted entry's reason
};
export const EXCLUDED = ['/proc', '/sys', '/dev', '/tmp', '/run'];
export const VARIANTS = ['wasm32_nommu', 'wasm64_nommu'];

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });
const HEX64 = /^[0-9a-f]{64}$/;
const DECIMAL = /^-?\d{1,19}$/;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

const invalid = (msg) => new Error('invalid session: ' + msg);

const requireApi = () => {
  for (const name of ['CompressionStream', 'DecompressionStream']) {
    if (typeof globalThis[name] !== 'function') throw new Error(`this browser lacks ${name}, which sessions need`);
  }
  if (!globalThis.crypto?.subtle) throw new Error('this page has no crypto.subtle (it must be a secure context)');
};

export const hexOf = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
export const sha256 = async (bytes) => {
  requireApi();
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
};

// True if the string survives a UTF-8 round trip (no lone surrogates, which would collapse distinct names).
const wellFormed = (s) => dec.decode(enc.encode(s)) === s;

/// Normalized absolute guest path: no NUL, no empty/./.. components, no trailing slash (except "/"), not excluded.
export function checkPath(p) {
  if (typeof p !== 'string') throw invalid('path is not a string');
  if (p.includes('\0')) throw invalid('path contains NUL');
  if (!wellFormed(p)) throw invalid('path is not well-formed Unicode');
  if (enc.encode(p).length > LIMITS.path) throw invalid('path is too long');
  if (p === '/') return p;
  if (!p.startsWith('/') || p.endsWith('/')) throw invalid(`path ${JSON.stringify(p)} must be absolute, without a trailing slash`);
  for (const c of p.split('/').slice(1)) {
    if (c === '' || c === '.' || c === '..') throw invalid(`path ${JSON.stringify(p)} has an invalid component`);
    if (enc.encode(c).length > LIMITS.name) throw invalid('path component is too long');
  }
  for (const x of EXCLUDED) if (p === x || p.startsWith(x + '/')) throw invalid(`path ${p} is outside the session`);
  return p;
}

const parentOf = (p) => p.slice(0, p.lastIndexOf('/')) || '/';

function checkTarget(t) {
  if (typeof t !== 'string' || t === '') throw invalid('link target must be a non-empty string');
  if (t.includes('\0')) throw invalid('link target contains NUL');
  if (!wellFormed(t)) throw invalid('link target is not well-formed Unicode');
  if (enc.encode(t).length > LIMITS.path) throw invalid('link target is too long');
  return t;
}

/// A plain-JSON copy of a host value. Rejects anything JSON would silently change or drop: cycles, functions, symbols,
/// undefined, BigInt, non-finite numbers, class instances, symbol-keyed or non-enumerable properties, accessors (their
/// getters are not run), and sparse arrays or extra array properties.
export function cloneHostState(value) {
  const active = new Set();
  const walk = (v, depth) => {
    if (depth > LIMITS.depth) throw new Error('hostState is nested too deeply');
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new Error('hostState contains a non-finite number');
      return v;
    }
    if (typeof v !== 'object') throw new Error(`hostState contains a ${typeof v} value, which cannot be saved`);
    if (active.has(v)) throw new Error('hostState contains a cycle');
    const proto = Object.getPrototypeOf(v);
    if (Object.getOwnPropertySymbols(v).length) throw new Error('hostState contains a symbol-keyed property');
    active.add(v);
    try {
      if (Array.isArray(v)) {
        const names = Object.getOwnPropertyNames(v);
        if (names.length !== v.length + 1) throw new Error('hostState contains an array with extra properties or holes');
        const out = [];
        for (let i = 0; i < v.length; i++) {
          const d = Object.getOwnPropertyDescriptor(v, i);
          if (!d) throw new Error('hostState contains a sparse array');
          if (!('value' in d)) throw new Error('hostState contains an accessor property');
          out.push(walk(d.value, depth + 1));
        }
        return out;
      }
      if (proto !== Object.prototype && proto !== null) throw new Error('hostState contains a non-plain object');
      const out = {};
      for (const k of Object.getOwnPropertyNames(v)) {
        const d = Object.getOwnPropertyDescriptor(v, k);
        if (!d.enumerable) throw new Error(`hostState property ${JSON.stringify(k)} is not enumerable`);
        if (!('value' in d)) throw new Error(`hostState property ${JSON.stringify(k)} is an accessor`);
        out[k] = walk(d.value, depth + 1);
      }
      return out;
    } finally {
      active.delete(v);
    }
  };
  return walk(value === undefined ? null : value, 0);
}

function checkMeta(e, p) {
  if (!Number.isSafeInteger(e.mode) || e.mode < 0 || e.mode > 0o7777) throw invalid(`${p}: bad mode`);
  for (const k of ['uid', 'gid']) {
    if (!Number.isSafeInteger(e[k]) || e[k] < 0 || e[k] > 4294967294) throw invalid(`${p}: bad ${k}`);
  }
  if (typeof e.mtimeSec !== 'string' || !DECIMAL.test(e.mtimeSec)) throw invalid(`${p}: bad mtime`);
  const s = BigInt(e.mtimeSec);
  if (s < INT64_MIN || s > INT64_MAX) throw invalid(`${p}: mtime out of range`);
  if (!Number.isSafeInteger(e.mtimeNsec) || e.mtimeNsec < 0 || e.mtimeNsec > 999999999) throw invalid(`${p}: bad mtime nsec`);
}

const sameMeta = (a, b) => a.mode === b.mode && a.uid === b.uid && a.gid === b.gid &&
  a.mtimeSec === b.mtimeSec && a.mtimeNsec === b.mtimeNsec;

/// Checks a parsed manifest completely (everything that can be checked without the payload). Returns the payload size.
export function validateManifest(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw invalid('manifest is not an object');
  if (m.format !== 'winix-session' || m.version !== 1 || m.kind !== 'filesystem') {
    throw invalid('not a winix filesystem session, version 1');
  }
  if (!VARIANTS.includes(m.variant)) throw invalid('unsupported variant');
  if (typeof m.createdAt !== 'string') throw invalid('missing createdAt');
  if (!m.build || !HEX64.test(m.build.kernelSha256) || !HEX64.test(m.build.initrdSha256)) throw invalid('missing build identity');
  cloneHostState(m.hostState ?? null);
  if (!Array.isArray(m.entries) || m.entries.length > LIMITS.entries) throw invalid('bad entry list');
  if (!Array.isArray(m.omitted) || m.omitted.length > LIMITS.entries) throw invalid('bad omitted list');

  const byPath = new Map();
  let payload = 0;
  for (const e of m.entries) {
    if (!e || typeof e !== 'object') throw invalid('entry is not an object');
    const p = checkPath(e.path);
    if (byPath.has(p)) throw invalid(`duplicate path ${p}`);
    if (!['file', 'dir', 'symlink', 'hardlink'].includes(e.type)) throw invalid(`${p}: unknown type`);
    checkMeta(e, p);
    if (e.type === 'file') {
      if (!Number.isSafeInteger(e.size) || e.size < 0 || e.size > LIMITS.payload) throw invalid(`${p}: bad size`);
      if (!Array.isArray(e.chunkHashes) || e.chunkHashes.length !== Math.ceil(e.size / CHUNK)) throw invalid(`${p}: bad chunk count`);
      if (!e.chunkHashes.every((h) => typeof h === 'string' && HEX64.test(h))) throw invalid(`${p}: bad chunk hash`);
      payload += e.size;
      if (payload > LIMITS.payload) throw invalid('payload is too large');
    } else if (e.type === 'symlink') {
      checkTarget(e.target);
    }
    byPath.set(p, e);
  }
  if (byPath.get('/')?.type !== 'dir') throw invalid('the root must be a directory');
  for (const [p, e] of byPath) {
    if (p !== '/') {
      const parent = byPath.get(parentOf(p));
      if (!parent || parent.type !== 'dir') throw invalid(`${p} has no directory parent in the session`);
    }
    if (e.type === 'hardlink') {
      const t = byPath.get(checkPath(e.target));
      if (!t || t.type !== 'file') throw invalid(`${p}: hard link target is not a regular file in the session`);
      if (!sameMeta(e, t)) throw invalid(`${p}: hard link metadata differs from its target`);
    }
  }
  // Omitted entries are informational only: they never authorize a write.
  for (const o of m.omitted) {
    if (!o || typeof o !== 'object' || typeof o.path !== 'string' || typeof o.reason !== 'string') throw invalid('bad omitted entry');
    if (o.path.includes('\0') || !wellFormed(o.path) || enc.encode(o.path).length > LIMITS.path) throw invalid('bad omitted path');
    if (o.reason.includes('\0') || enc.encode(o.reason).length > LIMITS.reason) throw invalid('bad omitted reason');
  }
  return payload;
}

// Input may be a Blob (File included), an ArrayBuffer, or a Uint8Array.
function toBlob(input) {
  if (input instanceof Blob) return input;
  if (input instanceof ArrayBuffer || input instanceof Uint8Array) return new Blob([input]);
  throw new TypeError('expected a Blob, File, ArrayBuffer or Uint8Array session');
}

/// Reads and verifies an archive as a stream: the header and manifest are checked before any payload is consumed, and
/// each file chunk is hashed as it is read. Returns { manifest, payload } with payload a Blob of all file bytes in order.
export async function readArchive(input) {
  requireApi();
  const blob = toBlob(input);
  if (blob.size > LIMITS.archive) throw invalid('the file is too large (max 512 MiB)');
  const reader = blob.stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  let buf = new Uint8Array(0);
  let eof = false;
  const fill = async (n) => {
    while (buf.length < n) {
      if (eof) throw invalid('the file is truncated');
      let step;
      try {
        step = await reader.read();
      } catch (e) {
        throw invalid('the file is corrupt or truncated (' + (e.message || e) + ')');
      }
      if (step.done) {
        eof = true;
        continue;
      }
      const next = new Uint8Array(buf.length + step.value.length);
      next.set(buf);
      next.set(step.value, buf.length);
      buf = next;
    }
  };
  const take = async (n) => {
    await fill(n);
    const out = buf.slice(0, n);
    buf = buf.subarray(n);
    return out;
  };
  try {
    await fill(44);
    if (dec.decode(buf.subarray(0, 8)) !== MAGIC) throw invalid('not a winix session file (bad magic)');
    const mlen = new DataView(buf.buffer, buf.byteOffset).getUint32(8, true);
    if (mlen > LIMITS.manifest) throw invalid('the manifest is too large');
    const sha = buf.slice(12, 44);
    buf = buf.subarray(44);
    const mbytes = await take(mlen);
    if (hexOf(await sha256(mbytes)) !== hexOf(sha)) throw invalid('manifest checksum mismatch');
    let manifest;
    try {
      manifest = JSON.parse(dec.decode(mbytes));
    } catch {
      throw invalid('manifest is not valid UTF-8 JSON');
    }
    const payloadSize = validateManifest(manifest);
    const pieces = [];
    for (const e of manifest.entries) {
      if (e.type !== 'file') continue;
      for (let i = 0; i < e.chunkHashes.length; i++) {
        const piece = await take(Math.min(CHUNK, e.size - i * CHUNK));
        if (hexOf(await sha256(piece)) !== e.chunkHashes[i]) throw invalid(`${e.path}: checksum mismatch in chunk ${i}`);
        pieces.push(new Blob([piece]));
      }
    }
    if (buf.length) throw invalid('file data does not match the manifest (trailing bytes)');
    for (;;) {
      let step;
      try {
        step = await reader.read();
      } catch (e) {
        throw invalid('the file is corrupt or truncated (' + (e.message || e) + ')');
      }
      if (step.done) break;
      if (step.value.length) throw invalid('file data does not match the manifest (trailing bytes)');
    }
    return { manifest, payload: new Blob(pieces, { type: 'application/octet-stream' }) };
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  }
}

/// Encodes a manifest and its payload (Blobs or Uint8Arrays, in order) as a gzip-compressed archive Blob. The result must
/// be within the same size limit that restore enforces, so an export never produces a file it cannot reload.
export async function encodeArchive(manifest, payloadParts) {
  requireApi();
  const payloadSize = validateManifest(manifest);
  const partsSize = payloadParts.reduce((n, p) => n + (p instanceof Blob ? p.size : p.length), 0);
  if (partsSize !== payloadSize) throw invalid('payload does not match the manifest');
  const mbytes = enc.encode(JSON.stringify(manifest));
  if (mbytes.length > LIMITS.manifest) throw invalid('the manifest is too large');
  const head = new Uint8Array(44 + mbytes.length);
  head.set(enc.encode(MAGIC), 0);
  new DataView(head.buffer).setUint32(8, mbytes.length, true);
  head.set(await sha256(mbytes), 12);
  head.set(mbytes, 44);
  const gz = new Blob([head, ...payloadParts]).stream().pipeThrough(new CompressionStream('gzip'));
  const out = await new Response(gz).blob();
  if (out.size > LIMITS.archive) {
    throw new Error('this session is larger than 512 MiB compressed; stop background writers or remove large files');
  }
  return out;
}
