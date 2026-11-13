// Focused regression for the Blink wasm JIT's register-only semantic tier (not a benchmark).
// Runs tests/fixtures/jit-trace.S under blink with the JIT in trace mode, with the trace tier off (NOTRACE),
// and with the interpreter only. Build the fixtures first: scripts/build-jit-fixtures.sh (WSL/Linux).
// Usage: node tests/jit-trace.mjs [url=http://127.0.0.1:8000/jit-trace.html]
// Env: PW_CHANNEL (e.g. msedge), PLAYWRIGHT_CORE (path to playwright-core).
import { createRequire } from "node:module";
import fs from "node:fs";
fs.mkdirSync("build", { recursive: true });

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const url = process.argv[2] ?? "http://127.0.0.1:8000/jit-trace.html";
const OVERALL_TIMEOUT_MS = 300000;

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL });
let results = null;
let pageError = null;
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => { pageError = String(e); });
  await page.goto(url);
  await page.waitForFunction(() => window.__done === true, null, { timeout: OVERALL_TIMEOUT_MS, polling: 1000 });
  results = await page.evaluate(() => window.__results);
} catch (e) {
  pageError = pageError ?? String(e.message || e);
} finally {
  await browser.close();
}

const checks = [];
const check = (name, ok, detail = "") => checks.push({ name, ok, detail });
if (!results) {
  check("page completed", false, pageError ?? "no results");
} else {
  check("boot and install", !results.error && results.install?.exitCode === 0 && !results.install?.timedOut,
    results.error ?? results.install?.stderr ?? "");
  for (const mode of ["nojit", "default", "trace", "notrace"]) {
    const r = results.modes?.[mode];
    check(`${mode}: exit 0 and exact output`, !!r && r.exitCode === 0 && r.stdoutOk,
      r ? JSON.stringify(r.stdout) + " exit " + r.exitCode : "missing");
    check(`${mode}: not timed out or truncated`, !!r && r.timedOut === false && r.truncated === false,
      r ? `timedOut=${r.timedOut} truncated=${r.truncated}` : "missing");
    if (mode === "nojit") continue;
    check(`${mode}: paths>0`, !!r && r.paths > 0, String(r?.paths));
    check(`${mode}: failed=0`, !!r && r.failed === 0, String(r?.failed));
  }
  const d = results.modes?.default;
  check("default: no errors on stderr", !!d && d.stderr.trim() === "", d ? JSON.stringify(d.stderr) : "missing");
  check("default: trace_ops=0", !!d && d.traceOps === 0, String(d?.traceOps));
  check("default: trace_regions=0", !!d && d.traceRegions === 0, String(d?.traceRegions));
  check("default: flag_elided=0", !!d && d.flagElided === 0, String(d?.flagElided));
  const t = results.modes?.trace, n = results.modes?.notrace;
  check("trace: trace_ops>0", !!t && t.traceOps > 0, String(t?.traceOps));
  check("trace: trace_regions>0", !!t && t.traceRegions > 0, String(t?.traceRegions));
  check("notrace: trace_ops=0", !!n && n.traceOps === 0, String(n?.traceOps));
  check("notrace: trace_regions=0", !!n && n.traceRegions === 0, String(n?.traceRegions));
  check("trace: flag_elided>0", !!t && t.flagElided > 0, String(t?.flagElided));
  check("notrace: flag_elided=0", !!n && n.flagElided === 0, String(n?.flagElided));
}
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.ok ? "" : "  " + c.detail}`);
fs.writeFileSync("build/jit-trace.json", JSON.stringify({ url, pageError, results, checks }, null, 2));
process.exit(checks.every((c) => c.ok) ? 0 : 1);
