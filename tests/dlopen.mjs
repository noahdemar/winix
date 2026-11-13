// dlopen in the guest (guest/dl.c, src/dylink.js, patches/runtime/0008): a C program loading shared objects, then
// CPython importing a C extension module. Build first: scripts/build.sh packages python dltest (python before
// dltest, whose extension module needs its headers). Serve dist/ with `node scripts/serve.mjs dist 8000`, then:
// node tests/dlopen.mjs [origin]. The linker alone is tested without a browser by tests/dylink.mjs.
// Writes build/dlopen-results.json. Env: PW_CHANNEL (e.g. msedge), PLAYWRIGHT_CORE (path to playwright-core).
import { createRequire } from "node:module";
import fs from "node:fs";
fs.mkdirSync("build", { recursive: true });

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const origin = process.argv[2] ?? "http://127.0.0.1:8000";

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL });
let results = [], pageError = null;
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => { pageError = String(e); });
  await page.goto(`${origin}/api.html`); // a page that boots nothing by itself
  results = await page.evaluate(async () => {
    const { Winix } = await import("/winix.js");
    const out = [];
    const check = async (name, w, cmd, test, opts = {}) => {
      const t0 = performance.now();
      try {
        const r = await w.exec(cmd, { timeoutMs: 120000, ...opts });
        const ok = test(r);
        out.push({ name, ok, ms: performance.now() - t0, detail: ok ? "" : JSON.stringify(r).slice(0, 1500) });
        return r;
      } catch (e) {
        out.push({ name, ok: false, ms: performance.now() - t0, detail: String(e.message || e) });
        return null;
      }
    };
    const w = await Winix.boot();
    await check("apt-get install dltest", w, "apt-get install -y dltest 2>&1", (r) => r.exitCode === 0);
    const c = await check("dltest: every check passes", w, "dltest",
      (r) => r.exitCode === 0 && r.stdout.endsWith("PASSED\n") && !r.stdout.includes("FAIL"));
    if (c) out.push({ name: "dltest: ran its checks", ok: c.stdout.split("\n").filter((l) => l.startsWith("ok ")).length >= 20,
      ms: 0, detail: c.stdout.slice(0, 1500) });
    await check("dltest twice more (fresh processes reuse the addresses)", w, "dltest >/dev/null && dltest | tail -1",
      (r) => r.stdout === "PASSED\n");

    await check("threads: created after dlopen, they call into the library", w, "dltest /usr/lib/dltest threads | tail -4",
      (r) => r.stdout.endsWith("ok threads share memory under a mutex\nPASSED\n"), { timeoutMs: 60000 });

    const py = await w.exec("apt-get install -y python 2>&1 && echo INSTALLED", { timeoutMs: 180000 });
    const havePython = py.stdout.includes("INSTALLED");
    out.push({ name: "apt-get install python", ok: havePython, ms: py.durationMs, detail: havePython ? "" : py.stdout.slice(-400) });
    if (havePython) {
      await w.writeFile("/work/ext.py", [
        "import subprocess, sys",
        "import _dltest",
        "print(_dltest.add(2, 3), _dltest.answer, _dltest.__file__)",
        "c = _dltest.Counter(); c.bump(); c.bump(); print(c.value, type(c).__name__)",
        "class Sub(_dltest.Counter): pass",
        "s = Sub(); s.bump(); print(s.value, isinstance(s, _dltest.Counter))",
        "try: _dltest.fail()",
        "except ValueError as e: print('ValueError:', e)",
        "print(_dltest.apply(lambda x: x * 2, 21), _dltest.same_pointers())",
        "print(subprocess.run(['echo', 'child'], capture_output=True, text=True).stdout.strip())",
        "print(_dltest.add(40, 2), sys.modules['_dltest'] is _dltest)",
      ].join("\n"));
      await check("python: import and use a C extension module", w, "python3 /work/ext.py",
        (r) => r.exitCode === 0 && r.stdout === "5 42 /usr/lib/python3.12/site-packages/_dltest.so\n2 Counter\n1 True\n" +
          "ValueError: raised in C\n42 True\nchild\n42 True\n");
      await check("python: a missing extension is an ImportError, not a crash", w,
        "echo 'not a module' > /work/_broken.so; cd /work && python3 -c 'import _broken' 2>&1 | tail -1",
        (r) => /^ImportError: .*not a shared object/.test(r.stdout));
      await check("python: still starts and runs without any extension", w, "python3 -c 'import json, sqlite3, ssl; print(json.dumps([1]))'",
        (r) => r.stdout === "[1]\n");
    }
    w.dispose();
    return out;
  });
} finally {
  await browser.close();
}

fs.writeFileSync("build/dlopen-results.json", JSON.stringify(results, null, 2));
for (const c of results) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}  (${Math.round(c.ms)} ms)${c.ok ? "" : "\n      " + c.detail}`);
if (pageError) console.log("[pageerror]", pageError);
process.exit(results.length && results.every((c) => c.ok) && !pageError ? 0 : 1);
