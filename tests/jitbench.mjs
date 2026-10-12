// Times x86-64 Python under Blink with and without the wasm JIT, in a browser without DevTools attached.
// Usage: node tests/jitbench.mjs [url=http://127.0.0.1:8000/]
// JITBENCH_ENVS: comma-separated environments to compare (default "WINIX_NOJIT=1,WINIX_JITSTATS=1").
// JITBENCH_ROOTFS: optional same-origin archive of a cached Alpine Python rootfs (no network downloads).
// JITBENCH_BASELINE_PACKAGE: optional same-origin old Blink archive for a paired old/new comparison.
// JITBENCH_OUTPUT: results JSON path (default build/jitbench-results.json). One sample per configuration.
// Env: PW_CHANNEL (e.g. msedge), PLAYWRIGHT_CORE (path to playwright-core). Needs scripts/serve.mjs (for /__proxy).
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const url = process.argv[2] ?? "http://127.0.0.1:8000/";
const rootfs = process.env.JITBENCH_ROOTFS ?? "";
const baselinePackage = process.env.JITBENCH_BASELINE_PACKAGE ?? "";
const output = process.env.JITBENCH_OUTPUT ?? "build/jitbench-results.json";
const envs = (process.env.JITBENCH_ENVS ?? "WINIX_NOJIT=1,WINIX_JITSTATS=1").split(",");
if (envs.some((s) => !/^(?:[A-Z_][A-Z_0-9]*=[A-Za-z0-9_-]+)(?: [A-Z_][A-Z_0-9]*=[A-Za-z0-9_-]+)*$/.test(s))) {
  throw new Error("JITBENCH_ENVS must contain comma-separated environment assignments");
}

const script = `
import time, json, re
t = time.perf_counter()
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
mixed = [fib(22), sum(g(20000)), len(re.findall(r"[0-9]+", s)), d2["1999"]]
mixed_ms = (time.perf_counter() - t) * 1000
t = time.perf_counter()
loop_sum = sum(range(10**6))
loop_ms = (time.perf_counter() - t) * 1000
print("WINIX_BENCH " + json.dumps(dict(mixed=mixed, loop_sum=loop_sum, mixed_ms=mixed_ms, loop_ms=loop_ms)))
`;

// Expected answers are checked independently of the emulated Python and its JIT.
let generatorSum = 0;
for (let i = 0; i < 20000; i++) generatorSum += i % 7 === 0 ? -i : i * i;
const expected = {
  mixed: [17711, generatorSum, 6000, [1999, 3998]],
  loop_sum: 499999500000,
};

fs.mkdirSync(path.dirname(output), { recursive: true });
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL });
try {
  const page = await browser.newPage();
  // The demo's index.html boots its own guest; avoid an extra sandbox competing with the measured one.
  await page.goto(new URL("machine.html", url).href);
  const data = await page.evaluate(async ({ script, envs, rootfs, baselinePackage }) => {
    const { Winix, proxyFetch } = await import("/winix.js");
    const rootUrl = rootfs ? new URL(rootfs, location.href) : null;
    if (rootUrl && rootUrl.origin !== location.origin) throw new Error("JITBENCH_ROOTFS must be same-origin");
    const baselineUrl = baselinePackage ? new URL(baselinePackage, location.href) : null;
    if (baselineUrl && baselineUrl.origin !== location.origin) throw new Error("JITBENCH_BASELINE_PACKAGE must be same-origin");
    if (baselineUrl && !rootUrl) throw new Error("A paired baseline comparison requires JITBENCH_ROOTFS");
    const w = await Winix.boot({ fetch: proxyFetch() });
    const quote = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
    const check = (r, label) => {
      if (r.exitCode !== 0 || r.timedOut || r.truncated) {
        throw new Error(`${label}: exit=${r.exitCode}, timedOut=${r.timedOut}, truncated=${r.truncated}\n${r.stderr}\n${r.stdout}`);
      }
      return r;
    };
    try {
      let python = "python3";
      if (rootUrl) {
        check(await w.exec(
          `apt-get install -y blink && mkdir -p /opt/x86 && curl -fs -o /tmp/python-rootfs.tgz ${quote(rootUrl.href)} && ` +
          "tar xzf /tmp/python-rootfs.tgz -C /opt/x86", { timeoutMs: 120000 }), "cached Python setup");
        python = "env BLINK_OVERLAYS=:/opt/x86 blink /opt/x86/usr/bin/python3";
      } else {
        check(await w.exec("apt-get install -y python3", { timeoutMs: 120000 }), "Python install");
      }
      const version = check(await w.exec(`${python} --version`), "Python version").stdout.trim();
      const packages = await (await fetch("/pkgs/index.txt")).text();
      const builds = [];
      if (baselineUrl) {
        check(await w.exec(
          `mkdir -p /tmp/bench-old && curl -fs -o /tmp/blink-old.tgz ${quote(baselineUrl.href)} && ` +
          "tar xzf /tmp/blink-old.tgz -C /tmp/bench-old", { timeoutMs: 60000 }), "baseline Blink setup");
        builds.push({ build: "baseline", python: "env BLINK_OVERLAYS=:/opt/x86 /tmp/bench-old/usr/bin/blink /opt/x86/usr/bin/python3" });
      }
      builds.push({ build: "current", python });
      await w.writeFile("/tmp/t.py", script);
      const samples = [];
      for (const env of envs) {
        for (const { build, python: command } of builds) {
          const startup = check(await w.exec(`env ${env} ${command} -c 1`, { timeoutMs: 60000 }), "startup");
          const r = check(await w.exec(`env ${env} ${command} /tmp/t.py`, { timeoutMs: 120000 }), "workload");
          const lines = r.stdout.trim().split("\n");
          if (lines.length !== 1 || !lines[0].startsWith("WINIX_BENCH ")) {
            throw new Error("Unexpected benchmark output: " + r.stdout);
          }
          const result = JSON.parse(lines[0].slice("WINIX_BENCH ".length));
          samples.push({
            build, env, startupMs: startup.durationMs, wallMs: r.durationMs,
            ...result, stderr: r.stderr, startupStderr: startup.stderr,
          });
        }
      }
      return { version, packages, rootfs: rootUrl?.href ?? null, baselinePackage: baselineUrl?.href ?? null, samples };
    } finally {
      w.dispose();
    }
  }, { script, envs, rootfs, baselinePackage });
  for (const sample of data.samples) {
    if (JSON.stringify(sample.mixed) !== JSON.stringify(expected.mixed) || sample.loop_sum !== expected.loop_sum) {
      throw new Error(`${sample.env}: wrong workload answer: ${JSON.stringify(sample)}`);
    }
    for (const key of ["startupMs", "wallMs", "mixed_ms", "loop_ms"]) {
      if (!Number.isFinite(sample[key]) || sample[key] < 0) throw new Error(`Invalid ${key}: ${sample[key]}`);
    }
    if (/\bfailed=[1-9][0-9]*\b/.test(sample.stderr)) throw new Error("JIT compilation failed: " + sample.stderr);
  }
  fs.writeFileSync(output, JSON.stringify({
    measuredAt: new Date().toISOString(), url, sampleCountPerConfig: 1, expected, script, ...data,
  }, null, 2));
  for (const s of data.samples) {
    console.log(`${s.build} ${s.env}: startup ${Math.round(s.startupMs)}ms | mixed ${Math.round(s.mixed_ms)}ms | loop ${Math.round(s.loop_ms)}ms | wall ${Math.round(s.wallMs)}ms`);
    if (s.stderr.trim()) console.log(s.stderr.trim());
  }
  console.log("Correct answers verified; single samples, not a statistically stable benchmark. Results: " + output);
} finally {
  await browser.close();
}
