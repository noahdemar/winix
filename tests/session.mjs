// Focused check of Save Session / Load Session (not a benchmark, not a stress run): one machine is saved and restored,
// and crafted archives must be rejected before any machine starts. Build first: scripts/build.sh guest (WSL).
// Usage: node tests/session.mjs [url=http://127.0.0.1:8000/session-test.html]
// Writes build/session-results.json. Env: PW_CHANNEL (e.g. msedge), PLAYWRIGHT_CORE (path to playwright-core).
import { createRequire } from "node:module";
import fs from "node:fs";
fs.mkdirSync("build", { recursive: true });

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const url = process.argv[2] ?? "http://127.0.0.1:8000/session-test.html";
const OVERALL_TIMEOUT_MS = 600000;

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL });
let results = null;
let pageError = null;
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => { pageError = String(e); });
  page.on("console", (m) => { if (m.type() === "error") console.log("[console]", m.text().slice(0, 300)); });
  await page.goto(url);
  await page.waitForFunction(() => window.__done === true, null, { timeout: OVERALL_TIMEOUT_MS, polling: 1000 });
  results = await page.evaluate(() => window.__results);
  await page.screenshot({ path: "build/session-test.png", fullPage: true }).catch(() => {});
} catch (e) {
  pageError = pageError ?? String(e.message || e);
} finally {
  await browser.close();
}

const cases = results?.cases ?? [];
const failed = cases.filter((c) => !c.ok);
const checks = [
  { name: "page completed", ok: !!results?.done && !pageError, detail: pageError ?? "" },
  ...cases.map((c) => ({ name: c.name, ok: c.ok, detail: c.detail })),
];
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.ok ? "" : "  " + c.detail}`);
console.log(`${cases.length - failed.length} of ${cases.length} cases passed`);
fs.writeFileSync("build/session-results.json", JSON.stringify({ url, pageError, checks }, null, 2));
process.exit(checks.every((c) => c.ok) ? 0 : 1);
