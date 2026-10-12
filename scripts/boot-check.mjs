// Headless boot check. Usage: node scripts/boot-check.mjs [url] [out=dist/boot-log.txt]
// Needs playwright-core (e.g. NODE_PATH to a global install) and a Chromium.
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const url = process.argv[2] ?? "http://127.0.0.1:8000/";
const out = process.argv[3] ?? "dist/boot-log.txt";

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL });
const page = await browser.newPage();
const consoleLines = [];
page.on("console", (m) => consoleLines.push(`[console.${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${e}`));
await page.goto(url);
const text = () => page.evaluate(() => document.querySelector("#terminal").innerText);

const deadline = Date.now() + 120000;
while (Date.now() < deadline && !/[#$] ?$/m.test((await text()).trimEnd().split("\n").pop())) await page.waitForTimeout(1000);

await page.locator("#terminal").click();
await page.keyboard.type("echo winix-ok $((6*7)); busybox | head -3; uname -a\n");
await page.waitForTimeout(5000);
const final = await text();
fs.writeFileSync(out, final + "\n\n--- browser console ---\n" + consoleLines.join("\n") + "\n");
console.log(final);
await browser.close();
