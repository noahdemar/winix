// Times x86-64 Python under Blink with and without the wasm JIT, in a browser without DevTools attached.
// Usage: node tests/jitbench.mjs [url=http://127.0.0.1:8000/]
// JITBENCH_ENVS: comma-separated environments to compare (default "WINIX_NOJIT=1,WINIX_JITSTATS=1").
// Env: PW_CHANNEL (e.g. msedge), PLAYWRIGHT_CORE (path to playwright-core). Needs scripts/serve.mjs (for /__proxy).
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const url = process.argv[2] ?? "http://127.0.0.1:8000/";

const script = `
import time, json, re
t = time.time()
def fib(n): return n if n < 2 else fib(n-1) + fib(n-2)
def g(n):
    for i in range(n):
        try:
            if i % 7 == 0: raise ValueError(i)
            yield i * i
        except ValueError as e:
            yield -int(str(e))
d = {str(i): [i, i*2] for i in range(2000)}
s = json.dumps(d); d2 = json.loads(s)
print(fib(22), sum(g(20000)), len(re.findall(r"[0-9]+", s)), d2["1999"])
print("mixed %.2fs" % (time.time() - t))
t = time.time(); sum(range(10**6)); print("loop %.2fs" % (time.time() - t))
`;

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL });
const page = await browser.newPage();
await page.goto(url);
const envs = (process.env.JITBENCH_ENVS ?? "WINIX_NOJIT=1,WINIX_JITSTATS=1").split(",");
const out = await page.evaluate(async ([script, envs]) => {
  const { Winix, proxyFetch } = await import("/winix.js");
  const w = await Winix.boot({ fetch: proxyFetch() });
  const lines = [];
  for (let i = 0; i < 3; i++) {
    const r = await w.exec("apt-get install -y python3 >/dev/null 2>&1 && python3 -c 1", { timeoutMs: 120000 });
    if (r.exitCode === 0) break;
  }
  await w.writeFile("/tmp/t.py", script);
  for (const env of envs) {
    const t0 = performance.now();
    await w.exec(`env ${env} python3 -c 1`, { timeoutMs: 60000 });
    const startup = performance.now() - t0;
    const r = await w.exec(`env ${env} python3 /tmp/t.py 2>&1`, { timeoutMs: 120000 });
    lines.push(`${env.padEnd(17)} startup ${Math.round(startup)}ms | ${r.stdout.trim().replace(/\n/g, " | ")}`);
  }
  return lines.join("\n");
}, [script, envs]);
console.log(out);
await browser.close();
