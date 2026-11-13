// Latency benchmark. Usage: node tests/bench.mjs [url=http://127.0.0.1:8000/bench.html]
// Env: PW_CHANNEL (e.g. msedge), PLAYWRIGHT_CORE (path to playwright-core).
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const url = process.argv[2] ?? "http://127.0.0.1:8000/bench.html";

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", String(e)));
await page.goto(url);
await page.waitForFunction(() => window.__done === true, null, { timeout: 180000, polling: 500 });
const bench = await page.evaluate(() => window.__bench);
await browser.close();
for (const [k, v] of Object.entries(bench)) console.log(`${k.padEnd(14)} ${v.toFixed(1)} ms`);
