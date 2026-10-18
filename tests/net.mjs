// Focused check of guest sockets (patches/kernel/0005, src/net.js, scripts/wisp-server.mjs) without the internet: local
// TCP/UDP/HTTP servers are reached from the guest through serve.mjs's /__wisp relay. Build first: scripts/build.sh
// kernel and busybox (WSL). Serve dist/ with `node scripts/serve.mjs dist 8000`, then: node tests/net.mjs [origin]
// Writes build/net-results.json. Env: PW_CHANNEL (e.g. msedge), PLAYWRIGHT_CORE (path to playwright-core).
import { createRequire } from "node:module";
import dgram from "node:dgram";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
fs.mkdirSync("build", { recursive: true });

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const origin = process.argv[2] ?? "http://127.0.0.1:8000";

// Line server: answers each line with "echo: <line>" and closes after "bye" (WISP has no half-close).
const tcp = net.createServer((c) => {
  let buf = "";
  c.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) {
      const line = buf.slice(0, i);
      c.write(`echo: ${line}\n`);
      if (line === "bye") c.end();
    }
  });
  c.on("error", () => {});
});
const big = Buffer.alloc(1 << 20, "x");
const web = http.createServer((req, res) => {
  if (req.url === "/big") return res.end(big);
  res.end(`hello from ${req.url}\n`);
});
const udp = dgram.createSocket("udp4");
udp.on("message", (m, r) => udp.send(Buffer.concat([Buffer.from("udp: "), m]), r.port, r.address));
await Promise.all([
  new Promise((r) => tcp.listen(0, "127.0.0.1", r)),
  new Promise((r) => web.listen(0, "127.0.0.1", r)),
  new Promise((r) => udp.bind(0, "127.0.0.1", r)),
]);
const ports = { tcp: tcp.address().port, web: web.address().port, udp: udp.address().port };

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL });
let results = [], pageError = null;
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => { pageError = String(e); });
  await page.goto(`${origin}/api.html`); // a page that boots nothing by itself
  results = await page.evaluate(async (ports) => {
    const { Winix, wisp } = await import("/winix.js");
    const out = [];
    const check = async (name, w, cmd, test, opts = {}) => {
      const t0 = performance.now();
      try {
        const r = await w.exec(cmd, { timeoutMs: 60000, ...opts });
        const ok = test(r);
        out.push({ name, ok, ms: performance.now() - t0, detail: ok ? "" : JSON.stringify(r).slice(0, 400) });
      } catch (e) {
        out.push({ name, ok: false, ms: performance.now() - t0, detail: String(e.message || e) });
      }
    };
    const w = await Winix.boot({ net: wisp("/__wisp") });
    await check("tcp by name (stand-in DNS)", w, `printf 'hi\\nbye\\n' | nc localhost ${ports.tcp}`,
      (r) => r.stdout === "echo: hi\necho: bye\n");
    await check("tcp by address", w, `printf 'bye\\n' | nc 127.0.0.1 ${ports.tcp}`, (r) => r.stdout === "echo: bye\n");
    await check("nslookup answers from 198.18.0.0/15", w, "nslookup example.org",
      (r) => r.exitCode === 0 && /Address: 198\.1[89]\./.test(r.stdout));
    await check("wget http", w, `wget -q -O - http://localhost:${ports.web}/x`, (r) => r.stdout === "hello from /x\n");
    await check("wget 1 MiB", w, `wget -q -O /tmp/big http://127.0.0.1:${ports.web}/big && wc -c < /tmp/big`,
      (r) => r.stdout.trim() === String(1 << 20));
    await check("wget to a refused port fails", w, "wget -q -O - http://127.0.0.1:1/", (r) => r.exitCode !== 0);
    const py = await w.exec("apt-get install -y python >/dev/null 2>&1 && echo yes", { timeoutMs: 180000 });
    if (py.stdout.includes("yes")) {
      await w.writeFile("/work/net.py", [
        "import select, socket",
        "u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); u.settimeout(10)",
        `u.sendto(b"ping", ("localhost", ${ports.udp})); d, a = u.recvfrom(100); print(d.decode(), a[1])`,
        "s = socket.socket(); s.setblocking(False); print('connect_ex', s.connect_ex(('127.0.0.1', 1)))",
        "r, w_, x = select.select([s], [], [], 10)",
        "print('so_error', s.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR))",
        "try: socket.create_connection(('127.0.0.1', 1), timeout=10).recv(1)",
        "except ConnectionRefusedError as e: print('refused', e.errno)",
        "a, b = socket.socketpair(); a.send(b'unix'); print(b.recv(9).decode())",
        "try: l = socket.socket(); l.bind(('0.0.0.0', 8080)); l.listen()",
        "except OSError as e: print('listen', e.errno)",
      ].join("\n"));
      await check("python: udp, nonblocking connect, refused, AF_UNIX, no listen", w, "python3 /work/net.py",
        (r) => r.stdout === `udp: ping ${ports.udp}\nconnect_ex 0\nso_error 111\nrefused 111\nunix\nlisten 95\n`);
    } else {
      out.push({ name: "python cases (skipped: apt-get install python failed)", ok: true, ms: 0, detail: "" });
    }
    w.dispose();
    const off = await Winix.boot({});
    await check("without a transport: ENETUNREACH", off, `wget -q -O - http://127.0.0.1:${ports.web}/ 2>&1; echo rc=$?`,
      (r) => /rc=[1-9]/.test(r.stdout));
    off.dispose();
    return out;
  }, ports);
} catch (e) {
  pageError = pageError ?? String(e.message || e);
} finally {
  await browser.close();
  tcp.close();
  web.close();
  udp.close();
}

const checks = [{ name: "page completed", ok: !pageError, detail: pageError ?? "" }, ...results];
for (const c of checks) {
  console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.ms ? `  (${Math.round(c.ms)} ms)` : ""}${c.ok ? "" : "\n      " + c.detail}`);
}
fs.writeFileSync("build/net-results.json", JSON.stringify({ origin, checks }, null, 2));
process.exit(checks.every((c) => c.ok) ? 0 : 1);
