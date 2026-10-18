// Guest networking: the kernel's AF_INET sockets (patches/kernel/0005) are channels the host relays. TCP and UDP go
// through a transport, normally wisp(url): a WebSocket to a WISP server that makes the real connections. DNS queries
// (UDP port 53, to any address) are answered here with stand-in addresses from 198.18.0.0/15; connecting to one of them
// connects to the name it stands for, so the WISP server does the real lookup.

export const SOCK_BIT = 0x40000000;

const ENETUNREACH = 101;
/// errno for a WISP close reason, when a TCP stream closes before the peer sent anything.
const CLOSE_ERRNO = { 0x02: 0, 0x03: 104 /* ECONNRESET */, 0x41: 22 /* EINVAL */, 0x42: 113 /* EHOSTUNREACH */,
  0x43: 110 /* ETIMEDOUT */, 0x44: 111 /* ECONNREFUSED */, 0x47: 111, 0x48: 111 };
const K = { CONNECT: 1, DATA: 2, UDP: 3, SHUTDOWN: 4 };

const le32 = (v) => new Uint8Array(new Uint32Array([v >>> 0]).buffer);
const ipString = (b, o) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;

/// Stand-in DNS: names get addresses in 198.18.0.0/15 (reserved for benchmarking, never routed), assigned in order.
class FakeDns {
  constructor() {
    this.byName = new Map();
    this.byAddr = new Map();
    this.next = 1;
  }
  addrFor(name) {
    name = name.toLowerCase().replace(/\.$/, '');
    let a = this.byName.get(name);
    if (a === undefined) {
      const n = this.next;
      this.next = (this.next % 0x1ffff) + 1;
      a = [198, 18 + (n >> 16), (n >> 8) & 255, n & 255];
      const key = a.join('.');
      const old = this.byAddr.get(key);
      if (old) this.byName.delete(old);
      this.byName.set(name, a);
      this.byAddr.set(key, name);
    }
    return a;
  }
  /// The name a stand-in address was given for, or the dotted address itself.
  hostFor(ip) {
    return this.byAddr.get(ip) ?? ip;
  }
  /// Answers a DNS query message; returns the response, or null if it cannot be parsed.
  answer(q) {
    if (q.length < 12) return null;
    const dv = new DataView(q.buffer, q.byteOffset, q.byteLength);
    if (dv.getUint16(4) !== 1) return null; // exactly one question
    let o = 12;
    const labels = [];
    while (o < q.length && q[o] !== 0) {
      const n = q[o];
      if (n > 63 || o + 1 + n > q.length) return null;
      labels.push(new TextDecoder().decode(q.subarray(o + 1, o + 1 + n)));
      o += 1 + n;
    }
    o++;
    if (o + 4 > q.length) return null;
    const qtype = dv.getUint16(o), qclass = dv.getUint16(o + 2);
    const question = q.subarray(12, o + 4);
    const name = labels.join('.');
    const a = qtype === 1 && qclass === 1 && name ? this.addrFor(name) : null;
    const out = new Uint8Array(12 + question.length + (a ? 16 : 0));
    const ov = new DataView(out.buffer);
    ov.setUint16(0, dv.getUint16(0)); // id
    ov.setUint16(2, 0x8180 | (dv.getUint16(2) & 0x0100)); // response, RD copied, RA, NOERROR
    ov.setUint16(4, 1);
    ov.setUint16(6, a ? 1 : 0); // AAAA and others: no data, so resolvers fall back to A
    out.set(question, 12);
    if (a) {
      let p = 12 + question.length;
      ov.setUint16(p, 0xc00c); // name: pointer to the question
      ov.setUint16(p + 2, 1);
      ov.setUint16(p + 4, 1);
      ov.setUint32(p + 6, 60);
      ov.setUint16(p + 10, 4);
      out.set(a, p + 12);
    }
    return out;
  }
}

/// Routes socket channels for one booted machine. `send(id, bytes)` and `close(id)` reach the guest's channel.
export class GuestNet {
  constructor({ send, close }, transport) {
    this.send = send;
    this.closeChannel = close;
    this.transport = transport;
    this.dns = new FakeDns();
    this.socks = new Map(); // id -> { tcp: stream|null, udp: Map(dest -> stream), closed }
  }

  data(id, bytes) {
    let s = this.socks.get(id);
    if (!s) this.socks.set(id, (s = { tcp: null, udp: new Map(), closed: false }));
    const kind = bytes[0];
    if (kind === K.CONNECT) this.#connect(id, s, ipString(bytes, 1), (bytes[5] << 8) | bytes[6]);
    else if (kind === K.DATA) s.tcp?.send(bytes.subarray(1));
    else if (kind === K.SHUTDOWN) s.tcp?.shutdown?.();
    else if (kind === K.UDP) this.#udp(id, s, bytes.subarray(1, 5), (bytes[5] << 8) | bytes[6], bytes.subarray(7));
  }

  close(id) {
    const s = this.socks.get(id);
    if (!s) return;
    this.socks.delete(id);
    s.closed = true;
    s.tcp?.close();
    for (const u of s.udp.values()) u.close();
  }

  dispose() {
    for (const id of [...this.socks.keys()]) this.close(id);
  }

  #toGuest(id, s, bytes) {
    if (!s.closed) this.send(id, bytes);
  }

  #connect(id, s, ip, port) {
    if (!this.transport) {
      this.#toGuest(id, s, le32(ENETUNREACH));
      return;
    }
    // WISP does not acknowledge connections, so the result goes ahead of the first bytes, or with the close.
    let reported = false;
    const report = (errno) => {
      if (!reported) this.#toGuest(id, s, le32(errno));
      reported = true;
    };
    const stream = (s.tcp = this.transport.open('tcp', this.dns.hostFor(ip), port));
    stream.ondata = (b) => {
      report(0);
      this.#toGuest(id, s, b);
    };
    stream.onclose = (reason) => {
      report(CLOSE_ERRNO[reason] ?? 104);
      if (!s.closed) this.closeChannel(id);
    };
  }

  #udp(id, s, addr, port, payload) {
    const ip = ipString(addr, 0);
    const reply = (b) => {
      const out = new Uint8Array(8 + b.length);
      out.set(addr, 0);
      out[4] = port >> 8;
      out[5] = port & 255;
      out[6] = b.length & 255;
      out[7] = b.length >> 8;
      out.set(b, 8);
      this.#toGuest(id, s, out);
    };
    if (port === 53) {
      const r = this.dns.answer(payload);
      if (r) reply(r);
      return;
    }
    if (!this.transport) return; // dropped, as datagrams may be
    const key = `${ip}:${port}`;
    let u = s.udp.get(key);
    if (!u) {
      s.udp.set(key, (u = this.transport.open('udp', this.dns.hostFor(ip), port)));
      u.ondata = reply;
      u.onclose = () => s.udp.delete(key);
    }
    u.send(payload);
  }
}

// ---- WISP v1 client (https://github.com/MercuryWorkshop/wisp-protocol) ----

const W = { CONNECT: 1, DATA: 2, CONTINUE: 3, CLOSE: 4 };

/// A transport over a WISP server at `url` (ws:// or wss://, or a path on this page's host). Connects on first use and
/// again after the WebSocket drops (open streams are closed then).
export function wisp(url) {
  let ws = null, ready = null, initialBuffer = 0, nextId = 1;
  const streams = new Map(); // id -> stream

  const packet = (type, id, payload) => {
    const out = new Uint8Array(5 + payload.length);
    out[0] = type;
    new DataView(out.buffer).setUint32(1, id, true);
    out.set(payload, 5);
    return out;
  };

  const connect = () => {
    if (ready) return ready;
    const href = new URL(url, location.href);
    href.protocol = href.protocol.replace(/^http/, 'ws');
    ws = new WebSocket(href.href);
    ws.binaryType = 'arraybuffer';
    ready = new Promise((resolve, reject) => {
      ws.onmessage = (e) => {
        const b = new Uint8Array(e.data);
        if (b.length < 5) return;
        const id = new DataView(b.buffer).getUint32(1, true);
        const payload = b.subarray(5);
        if (b[0] === W.CONTINUE && id === 0) {
          initialBuffer = new DataView(payload.buffer, payload.byteOffset).getUint32(0, true);
          resolve();
          return;
        }
        const s = streams.get(id);
        if (!s) return;
        if (b[0] === W.DATA) s.ondata?.(payload.slice());
        else if (b[0] === W.CONTINUE) s.cont(new DataView(payload.buffer, payload.byteOffset).getUint32(0, true));
        else if (b[0] === W.CLOSE) s.closed(payload[0]);
      };
      const drop = () => {
        ready = null;
        reject(new Error(`WISP connection to ${href} failed`));
        for (const s of [...streams.values()]) s.closed(0x03);
      };
      ws.onclose = drop;
      ws.onerror = drop;
    });
    return ready;
  };

  return {
    open(type, host, port) {
      const id = nextId++;
      let budget = 0, queue = [], open = true, opened = false;
      const flush = () => {
        while (queue.length && (type === 'udp' || budget > 0)) {
          ws.send(packet(W.DATA, id, queue.shift()));
          budget--;
        }
      };
      const s = {
        ondata: null,
        onclose: null,
        send(bytes) {
          if (!open) return;
          queue.push(bytes.slice());
          if (opened) flush();
        },
        shutdown() {}, // WISP has no half-close; the stream stays open until either side closes it
        close() {
          if (!open) return;
          open = false;
          streams.delete(id);
          if (opened && ws?.readyState === WebSocket.OPEN) ws.send(packet(W.CLOSE, id, new Uint8Array([0x02])));
        },
        cont(n) {
          budget = n;
          flush();
        },
        closed(reason) {
          if (!open) return;
          open = false;
          streams.delete(id);
          s.onclose?.(reason);
        },
      };
      streams.set(id, s);
      connect().then(() => {
        if (!open) return;
        const name = new TextEncoder().encode(host);
        const p = new Uint8Array(3 + name.length);
        p[0] = type === 'udp' ? 2 : 1;
        p[1] = port & 255;
        p[2] = port >> 8;
        p.set(name, 3);
        ws.send(packet(W.CONNECT, id, p));
        budget = initialBuffer;
        opened = true;
        flush();
      }, () => s.closed(0x03));
      return s;
    },
  };
}
