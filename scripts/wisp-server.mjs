// A small WISP v1 server (https://github.com/MercuryWorkshop/wisp-protocol) on a WebSocket, for guest sockets in
// development: attachWisp(httpServer, '/__wisp'). Makes real TCP connections and UDP exchanges for whoever connects,
// so serve it on localhost only. No dependencies: the WebSocket framing is done here.
import crypto from "node:crypto";
import dgram from "node:dgram";
import dns from "node:dns";
import net from "node:net";

const W = { CONNECT: 1, DATA: 2, CONTINUE: 3, CLOSE: 4 };
const REASON = { VOLUNTARY: 0x02, NETWORK: 0x03, INVALID: 0x41, UNREACHABLE: 0x42, TIMEOUT: 0x43, REFUSED: 0x44 };
const BUFFER = 128; // DATA packets a TCP stream may have in flight before we send CONTINUE

const reasonFor = (e) =>
  ({ ECONNREFUSED: REASON.REFUSED, ENOTFOUND: REASON.UNREACHABLE, EAI_AGAIN: REASON.UNREACHABLE,
    EHOSTUNREACH: REASON.UNREACHABLE, ENETUNREACH: REASON.UNREACHABLE, ETIMEDOUT: REASON.TIMEOUT })[e?.code] ??
  REASON.NETWORK;

/// Minimal server-side WebSocket: binary messages in and out, ping/pong, close.
function websocket(socket, onMessage, onClose) {
  let buf = Buffer.alloc(0), fragments = [], closed = false;
  const send = (opcode, payload) => {
    if (closed) return;
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | opcode, n]) :
      n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]) :
      Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
    socket.write(Buffer.concat([head, payload]));
  };
  const close = () => {
    if (closed) return;
    send(8, Buffer.alloc(0));
    closed = true;
    socket.end();
  };
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, opcode = buf[0] & 15, masked = buf[1] & 0x80;
      let len = buf[1] & 127, o = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); o = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); o = 10; }
      if (buf.length < o + (masked ? 4 : 0) + len) return;
      const mask = masked ? buf.subarray(o, o + 4) : null;
      o += masked ? 4 : 0;
      const payload = Buffer.from(buf.subarray(o, o + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(o + len);
      if (opcode === 8) return close();
      if (opcode === 9) { send(10, payload); continue; }
      if (opcode === 10) continue;
      fragments.push(payload);
      if (fin) {
        const msg = Buffer.concat(fragments);
        fragments = [];
        onMessage(msg);
      }
    }
  });
  socket.on("close", () => { closed = true; onClose(); });
  socket.on("error", () => socket.destroy());
  return { send: (b) => send(2, b), close };
}

function serveWisp(socket) {
  const streams = new Map(); // id -> { kind, conn, received, dest }
  const packet = (type, id, payload) => {
    const out = Buffer.alloc(5 + payload.length);
    out[0] = type;
    out.writeUInt32LE(id, 1);
    payload.copy(out, 5);
    return out;
  };
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
  const closeStream = (id, reason, notify = true) => {
    const s = streams.get(id);
    if (!s) return;
    streams.delete(id);
    if (s.kind === "tcp") s.conn.destroy();
    else s.conn.close();
    if (notify) ws.send(packet(W.CLOSE, id, Buffer.from([reason])));
  };

  const ws = websocket(socket, (msg) => {
    if (msg.length < 5) return;
    const type = msg[0], id = msg.readUInt32LE(1), payload = msg.subarray(5);
    if (type === W.CONNECT) {
      if (payload.length < 3 || streams.has(id)) return ws.send(packet(W.CLOSE, id, Buffer.from([REASON.INVALID])));
      const kind = payload[0] === 2 ? "udp" : "tcp", port = payload.readUInt16LE(1);
      const host = payload.subarray(3).toString("utf8");
      if (kind === "tcp") {
        const conn = net.connect({ host, port });
        const s = { kind, conn, received: 0 };
        streams.set(id, s);
        conn.setNoDelay(true);
        conn.on("data", (d) => ws.send(packet(W.DATA, id, d)));
        conn.on("drain", () => ws.send(packet(W.CONTINUE, id, u32(BUFFER))));
        conn.on("end", () => closeStream(id, REASON.VOLUNTARY));
        conn.on("error", (e) => closeStream(id, reasonFor(e)));
        conn.on("close", () => closeStream(id, REASON.VOLUNTARY));
      } else {
        const s = { kind, conn: null, dest: null, pending: [] };
        streams.set(id, s);
        dns.lookup(host, { family: 4 }, (err, address) => {
          if (!streams.has(id)) return;
          if (err) return closeStream(id, reasonFor(err));
          s.conn = dgram.createSocket("udp4");
          s.conn.on("message", (d) => ws.send(packet(W.DATA, id, d)));
          s.conn.on("error", (e) => closeStream(id, reasonFor(e)));
          s.dest = { address, port };
          for (const d of s.pending) s.conn.send(d, port, address);
          s.pending = null;
        });
      }
    } else if (type === W.DATA) {
      const s = streams.get(id);
      if (!s) return;
      if (s.kind === "tcp") {
        const flushed = s.conn.write(Buffer.from(payload));
        // Hand the client more budget halfway through, unless the socket is backed up (then on "drain").
        if (++s.received >= BUFFER / 2 && flushed) {
          s.received = 0;
          ws.send(packet(W.CONTINUE, id, u32(BUFFER)));
        }
      } else if (s.dest) {
        s.conn.send(Buffer.from(payload), s.dest.port, s.dest.address);
      } else {
        s.pending.push(Buffer.from(payload));
      }
    } else if (type === W.CLOSE) {
      closeStream(id, 0, false);
    }
  }, () => {
    for (const id of [...streams.keys()]) closeStream(id, 0, false);
  });
  ws.send(packet(W.CONTINUE, 0, u32(BUFFER)));
}

/// Serves WISP on `path` of an http.Server (WebSocket upgrade requests).
export function attachWisp(server, path = "/__wisp") {
  server.on("upgrade", (req, socket) => {
    const url = new URL(req.url, "http://x");
    const key = req.headers["sec-websocket-key"];
    if (url.pathname !== path || !key || req.headers.upgrade?.toLowerCase() !== "websocket") {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);
    serveWisp(socket);
  });
}
