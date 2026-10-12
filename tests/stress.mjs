// Stress: N fresh page loads of test.html (fresh machine each), classify pass / panic / fail.
// Usage: node tests/stress.mjs [N=30] [out=dist/stress.json] [url=http://127.0.0.1:8000/test.html]
// Env: PW_CHANNEL (e.g. msedge), PLAYWRIGHT_CORE (path to playwright-core).
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const N = Number(process.argv[2] ?? 30);
const out = process.argv[3] ?? "dist/stress.json";
const url = process.argv[4] ?? "http://127.0.0.1:8000/test.html";
const perRunMs = 180000;

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL });
const runs = [];
for (let i = 0; i < N; i++) {
  const page = await browser.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(url);
  let results = null, hung = false;
  try {
    await page.waitForFunction(() => window.__done === true, null, { timeout: perRunMs, polling: 500 });
    results = await page.evaluate(() => window.__results);
  } catch { hung = true; }
  const progress = hung ? await page.evaluate(() => document.getElementById('out')?.textContent).catch(() => null) : undefined;
  await page.close();

  const failed = results ? results.cases.filter((c) => !c.pass).map((c) => `${c.name}: ${c.error}`) : [];
  const text = errors.join("\n") + failed.join("\n");
  const panicLike = /Kernel panic|RuntimeError|stop secondary cpu|unreachable/.test(text);
  const frame = (text.match(/RuntimeError[^\n]*\n\s*at vmlinux\.unstripped\.(\w+)/) ?? text.match(/at vmlinux\.unstripped\.(\w+)/) ?? [])[1];
  let status = "pass";
  if (results?.bootError || (results && failed.length) || hung || errors.length) status = panicLike ? "panic" : hung ? "hang" : "fail";
  const run = {
    i, status,
    topFrame: panicLike ? (frame ?? "(no wasm frame)") : undefined,
    bootError: results?.bootError,
    stats: results?.stats,
    progress,
    failedCases: failed.length ? failed : undefined,
    errors: status === "pass" ? undefined : errors.map((e) => e.slice(0, 600)).slice(0, 4),
  };
  runs.push(run);
  console.log(`#${i} ${status}${run.topFrame ? " @" + run.topFrame : ""}${failed.length ? " failed=" + failed.length : ""}${run.stats ? " ooo=" + run.stats.consoleOutOfOrder + "/" + run.stats.consoleChunks + " retries=" + run.stats.integrityRetries : ""}`);
}
await browser.close();

const count = (s) => runs.filter((r) => r.status === s).length;
const frames = {};
for (const r of runs) if (r.status === "panic") frames[r.topFrame] = (frames[r.topFrame] ?? 0) + 1;
const withStats = runs.filter((r) => r.stats);
const sum = (k) => withStats.reduce((a, r) => a + (r.stats[k] ?? 0), 0);
const summary = {
  consoleChunks: sum("consoleChunks"),
  outOfOrderChunks: sum("consoleOutOfOrder"),
  gapSkips: sum("consoleGapSkips"),
  integrityRetries: sum("integrityRetries"),
  runsWithOutOfOrder: withStats.filter((r) => r.stats.consoleOutOfOrder > 0).length,
  failedRunsWithOutOfOrder: withStats.filter((r) => r.status !== "pass" && r.stats.consoleOutOfOrder > 0).length,
  n: N, pass: count("pass"), panic: count("panic"), fail: count("fail"), hang: count("hang"), panicRate: count("panic") / N, topFrames: frames };
fs.writeFileSync(out, JSON.stringify({ summary, runs }, null, 2));
console.log("summary:", summary);
process.exit(summary.pass === N ? 0 : 1);
