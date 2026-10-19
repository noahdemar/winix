// Focused check of guest sockets (patches/kernel/0005, src/net.js, scripts/wisp-server.mjs) without the internet: local
// TCP/UDP/HTTP servers are reached from the guest through serve.mjs's /__wisp relay. Build first: scripts/build.sh
// kernel and busybox (WSL). Serve dist/ with `node scripts/serve.mjs dist 8000`, then: node tests/net.mjs [origin]
// The TLS case uses tests/fixtures/net-tls (a test-only CA and localhost certificate).
// Writes build/net-results.json. Env: PW_CHANNEL (e.g. msedge), PLAYWRIGHT_CORE (path to playwright-core).
import { createRequire } from "node:module";
import dgram from "node:dgram";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
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
const tlsDir = new URL("./fixtures/net-tls/", import.meta.url);
const secure = https.createServer({
  key: fs.readFileSync(new URL("server.key", tlsDir)), cert: fs.readFileSync(new URL("server.pem", tlsDir)),
}, (req, res) => res.end(`secure hello from ${req.url}\n`));
const testCa = fs.readFileSync(new URL("ca.pem", tlsDir), "utf8");
const udp = dgram.createSocket("udp4");
udp.on("message", (m, r) => udp.send(Buffer.concat([Buffer.from("udp: "), m]), r.port, r.address));
await Promise.all([
  new Promise((r) => tcp.listen(0, "127.0.0.1", r)),
  new Promise((r) => web.listen(0, "127.0.0.1", r)),
  new Promise((r) => udp.bind(0, "127.0.0.1", r)),
  new Promise((r) => secure.listen(0, "127.0.0.1", r)),
]);
const ports = { tcp: tcp.address().port, web: web.address().port, udp: udp.address().port,
  tls: secure.address().port, testCa };

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
    await check("tcp to localhost, no guest listener: the relay's host", w, `printf 'hi\\nbye\\n' | nc localhost ${ports.tcp}`,
      (r) => r.stdout === "echo: hi\necho: bye\n");
    await check("tcp by address", w, `printf 'bye\\n' | nc 127.0.0.1 ${ports.tcp}`, (r) => r.stdout === "echo: bye\n");
    await check("nslookup answers from 198.18.0.0/15", w, "nslookup example.org",
      (r) => r.exitCode === 0 && /Address: 198\.1[89]\./.test(r.stdout));
    await check("wget http", w, `wget -q -O - http://localhost:${ports.web}/x`, (r) => r.stdout === "hello from /x\n");
    await check("wget 1 MiB", w, `wget -q -O /tmp/big http://127.0.0.1:${ports.web}/big && wc -c < /tmp/big`,
      (r) => r.stdout.trim() === String(1 << 20));
    await check("wget to a refused port fails", w, "wget -q -O - http://127.0.0.1:1/", (r) => r.exitCode !== 0);
    const py = await w.exec("apt-get install -y python 2>&1 && echo INSTALLED", { timeoutMs: 180000 });
    const havePython = py.stdout.includes("INSTALLED");
    out.push({ name: "apt-get install python", ok: havePython, ms: py.durationMs, detail: havePython ? "" : py.stdout.slice(-400) });
    if (havePython) {
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
      ].join("\n"));
      await check("python: udp, nonblocking connect, refused, AF_UNIX", w, "python3 /work/net.py",
        (r) => r.stdout === `udp: ping ${ports.udp}\nconnect_ex 0\nso_error 111\nrefused 111\nunix\n`);
      await w.writeFile("/work/loop.py", [
        "import select, socket",
        "l = socket.socket(); l.bind(('127.0.0.1', 0)); l.listen(); l.setblocking(False)",
        "port = l.getsockname()[1]; print('listening', l.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN))",
        "try: l.accept()",
        "except BlockingIOError: print('accept EAGAIN')",
        "c = socket.create_connection(('localhost', port))",
        "r, _, _ = select.select([l], [], [], 10); a, addr = l.accept(); a.setblocking(True); print('accepted', addr[0])",
        "c.sendall(b'ping'); print(a.recv(9).decode()); a.sendall(b'pong'); print(c.recv(9).decode())",
        "c.shutdown(socket.SHUT_WR); print('eof', a.recv(9)); a.sendall(b'late'); print(c.recv(9).decode())",
        "a.close(); print('closed', c.recv(9))",
        "try: socket.create_connection(('10.0.2.15', 9)).recv(1)",
        "except ConnectionRefusedError as e: print('refused', e.errno)",
        "try: s = socket.socket(); s.bind(('0.0.0.0', port)); s.listen()",
        "except OSError as e: print('in use', e.errno)",
      ].join("\n"));
      await check("python: listen, accept, loopback, half-close, EADDRINUSE", w, "python3 /work/loop.py",
        (r) => r.stdout === "listening 1\naccept EAGAIN\naccepted 127.0.0.1\nping\npong\neof b''\nlate\n" +
          "closed b''\nrefused 111\nin use 98\n");
      await w.writeFile("/work/ca.pem", ports.testCa);
      await w.writeFile("/work/tls.py", [
        "import ssl, urllib.request",
        `url = 'https://localhost:${ports.tls}/x'`,
        "ctx = ssl.create_default_context(cafile='/work/ca.pem')",
        "print(urllib.request.urlopen(url, context=ctx).read().decode(), end='')",
        "try: urllib.request.urlopen(url)",
        "except Exception as e: print('default roots reject the test CA:', 'CERTIFICATE_VERIFY_FAILED' in str(e))",
        "print('system roots loaded:', ssl.create_default_context().cert_store_stats()['x509_ca'] > 100)",
      ].join("\n"));
      await check("python ssl: https with verification", w, "python3 /work/tls.py",
        (r) => r.stdout === "secure hello from /x\ndefault roots reject the test CA: True\nsystem roots loaded: True\n");
      await w.writeFile("/work/www/hi.txt", "hi from the guest\n");
      await w.writeFile("/work/srv.py", "import os\nfrom http.server import HTTPServer, SimpleHTTPRequestHandler\n" +
        "os.chdir('/work/www')\nHTTPServer(('0.0.0.0', 8080), SimpleHTTPRequestHandler).serve_forever()\n");
      await check("guest http server, fetched inside the guest", w,
        "python3 /work/srv.py >/tmp/srv.log 2>&1 & sleep 2; wget -q -O - http://127.0.0.1:8080/hi.txt",
        (r) => r.stdout === "hi from the guest\n");
      const t0 = performance.now();
      try {
        const res = await w.guestFetch(8080, "/hi.txt");
        const text = await res.text();
        const missing = await w.guestFetch(8080, "/nope");
        const ok = res.status === 200 && text === "hi from the guest\n" && missing.status === 404;
        out.push({ name: "page -> guest: guestFetch", ok, ms: performance.now() - t0,
          detail: ok ? "" : `${res.status} ${JSON.stringify(text)} ${missing.status}` });
      } catch (e) {
        out.push({ name: "page -> guest: guestFetch", ok: false, ms: performance.now() - t0, detail: String(e) });
      }
    }
    if (havePython) {
      await check("python subprocess (clone instead of fork)", w,
        `python3 -c "import subprocess as s; print(s.run(['echo', 'child'], capture_output=True, text=True).stdout.strip());` +
        ` print(s.run('exit 3', shell=True).returncode)\ntry: s.run(['no-such-program'])\nexcept FileNotFoundError: print('missing')"`,
        (r) => r.stdout === "child\n3\nmissing\n");
      const pip = await w.exec("apt-get install -y pip 2>&1 && echo INSTALLED", { timeoutMs: 180000 });
      const havePip = pip.stdout.includes("INSTALLED");
      out.push({ name: "apt-get install pip", ok: havePip, ms: pip.durationMs, detail: havePip ? "" : pip.stdout.slice(-400) });
      if (havePip) {
        // A minimal pure-Python wheel, built in the guest, so no package index is needed.
        await w.writeFile("/work/mkwheel.py", [
          "import base64, hashlib, zipfile",
          "files = {'hello_winix/__init__.py': b'GREETING = \"hello from a wheel\"\\n',",
          "  'hello_winix-1.0.dist-info/METADATA': b'Metadata-Version: 2.1\\nName: hello-winix\\nVersion: 1.0\\n',",
          "  'hello_winix-1.0.dist-info/WHEEL': b'Wheel-Version: 1.0\\nGenerator: winix\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n'}",
          "rec = ''.join(f'{n},sha256={base64.urlsafe_b64encode(hashlib.sha256(d).digest()).rstrip(b\"=\").decode()},{len(d)}\\n' for n, d in files.items())",
          "with zipfile.ZipFile('/work/hello_winix-1.0-py3-none-any.whl', 'w') as z:",
          "    for n, d in files.items(): z.writestr(n, d)",
          "    z.writestr('hello_winix-1.0.dist-info/RECORD', rec + 'hello_winix-1.0.dist-info/RECORD,,\\n')",
        ].join("\n"));
        await check("pip: install, import, uninstall a local wheel", w,
          "python3 /work/mkwheel.py && pip install -q /work/hello_winix-1.0-py3-none-any.whl && " +
          "python3 -c 'import hello_winix; print(hello_winix.GREETING)' && pip uninstall -y -q hello-winix && " +
          "python3 -c 'import hello_winix' 2>/dev/null || echo gone",
          (r) => r.stdout === "hello from a wheel\ngone\n", { timeoutMs: 120000 });
      }
    }
    {
      let errno = 0;
      try { w.connect(9999); } catch (e) { errno = e.errno; }
      out.push({ name: "page -> guest: connect to a closed port throws ECONNREFUSED", ok: errno === 111, ms: 0,
        detail: String(errno) });
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
  secure.close();
}

const checks = [{ name: "page completed", ok: !pageError, detail: pageError ?? "" }, ...results];
for (const c of checks) {
  console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.ms ? `  (${Math.round(c.ms)} ms)` : ""}${c.ok ? "" : "\n      " + c.detail}`);
}
fs.writeFileSync("build/net-results.json", JSON.stringify({ origin, checks }, null, 2));
process.exit(checks.every((c) => c.ok) ? 0 : 1);
