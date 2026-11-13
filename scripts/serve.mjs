// Static server with COOP/COEP headers (needed for SharedArrayBuffer), on localhost only.
// Also /__proxy?url=<http(s) url>: forwards the request server-side, so guest curl can reach sites without CORS.
// And /__wisp: a WISP WebSocket endpoint (scripts/wisp-server.mjs) that carries guest TCP/UDP sockets.
// Usage: node scripts/serve.mjs [dir=dist] [port=8000]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { attachWisp } from "./wisp-server.mjs";

const root = path.resolve(process.argv[2] ?? "dist");
const port = Number(process.argv[3] ?? 8000);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".gz": "application/gzip",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
};
// Hop-by-hop or rewritten by fetch (bodies arrive decompressed).
const dropHeaders = new Set(["host", "connection", "content-length", "content-encoding", "transfer-encoding", "keep-alive",
  "origin", "referer", "cookie", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest"]);

async function proxy(req, res, target) {
  if (!/^https?:$/.test(target.protocol)) return res.writeHead(400).end("only http(s) urls");
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!dropHeaders.has(k)) headers[k] = v;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    const r = await fetch(target, {
      method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined, redirect: "follow",
    });
    const out = {};
    r.headers.forEach((v, k) => { if (!dropHeaders.has(k) && k !== "set-cookie") out[k] = v; });
    res.writeHead(r.status, r.statusText, out);
    if (r.body) Readable.fromWeb(r.body).pipe(res);
    else res.end();
  } catch (e) {
    res.writeHead(502).end(`proxy: ${e.cause?.message ?? e.message}`);
  }
}

const server = http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    res.setHeader("Cache-Control", "no-store");
    if (url.pathname === "/__proxy") {
      let target;
      try { target = new URL(url.searchParams.get("url")); } catch { return res.writeHead(400).end("bad url"); }
      return proxy(req, res, target);
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    // Package archives are versioned by name, so the browser may keep them; everything else is always fresh.
    if (/^\/pkgs\/.+_.+\.tar\.gz$/.test(rel)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
attachWisp(server, "/__wisp");
server.listen(port, "127.0.0.1", () => console.log(`serving ${root} on http://127.0.0.1:${port}/`));
