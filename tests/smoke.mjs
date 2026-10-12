// Browser smoke tests. Usage: node tests/smoke.mjs [url=http://127.0.0.1:8000/test.html]
// Env: PW_CHANNEL (e.g. msedge), PLAYWRIGHT_CORE (path to playwright-core).
import { createRequire } from "node:module";
import fs from "node:fs";
fs.mkdirSync("build", { recursive: true });

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const url = process.argv[2] ?? "http://127.0.0.1:8000/test.html";

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", String(e)));
await page.goto(url);
await page.waitForFunction(() => window.__done === true, null, { timeout: 600000, polling: 500 });
const results = await page.evaluate(() => window.__results);
await browser.close();

if (results.bootError) { console.log("BOOT FAILED:", results.bootError); process.exit(1); }
fs.writeFileSync("build/smoke-results.json", JSON.stringify(results, null, 2));
for (const c of results.cases) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}  (${Math.round(c.ms)} ms)${c.pass ? "" : "\n      " + c.error}`);
console.log("timings:", results.timings);
process.exit(results.cases.every((c) => c.pass) ? 0 : 1);
