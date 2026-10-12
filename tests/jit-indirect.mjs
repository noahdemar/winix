// Focused regression for the Blink wasm JIT's memory-operand call/jmp fast path (not a benchmark).
// Runs tests/fixtures/jit-indirect.S under blink in WINIX_NOJIT, JIT, and JIT with NOSTACKFAST modes.
// Build the fixture and page first: scripts/build-jit-fixtures.sh (WSL/Linux). Serve dist/ on :8000 first:
//   node scripts/serve.mjs dist 8000
// Usage: node tests/jit-indirect.mjs [url=http://127.0.0.1:8000/jit-indirect.html]
// Env: PW_CHANNEL (e.g. msedge), PLAYWRIGHT_CORE (path to playwright-core).
import { createRequire } from "node:module";
import fs from "node:fs";
fs.mkdirSync("build", { recursive: true });

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const url = process.argv[2] ?? "http://127.0.0.1:8000/jit-indirect.html";
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
  for (const mode of ["nojit", "jit", "nostackfast"]) {
    const r = results.modes?.[mode];
    check(`${mode}: exit 0 and exact output`, !!r && r.exitCode === 0 && r.stdoutOk,
      r ? JSON.stringify(r.stdout) + " exit " + r.exitCode : "missing");
    check(`${mode}: not timed out or truncated`, !!r && r.timedOut === false && r.truncated === false,
      r ? `timedOut=${r.timedOut} truncated=${r.truncated}` : "missing");
    if (mode !== "nojit") {
      check(`${mode}: paths>0`, !!r && r.paths > 0, String(r?.paths));
      check(`${mode}: failed=0`, !!r && r.failed === 0, String(r?.failed));
    }
  }
}
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.ok ? "" : "  " + c.detail}`);
fs.writeFileSync("build/jit-indirect.json", JSON.stringify({ url, pageError, results, checks }, null, 2));
process.exit(checks.every((c) => c.ok) ? 0 : 1);
