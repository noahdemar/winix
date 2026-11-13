// Soak: many large processes in one session, the load under which the machine's memory used to get corrupted (a
// process dying with "Illegal instruction", or a kernel panic). Each round runs CMD and must exit 0 without the
// machine being rebuilt. Serve dist/ with `node scripts/serve.mjs dist 8000`, then:
//   node tests/soak.mjs [rounds=25] [origin=http://127.0.0.1:8000]
// Env: SOAK_CMD (default: python compiling its whole standard library, about 30 s a round), SOAK_SETUP (run once
// first; default: apt-get install -y python), PW_CHANNEL, PLAYWRIGHT_CORE. Writes build/soak-results.json; the guest
// console (kernel messages) of a failing run goes to build/soak-console.txt.
import { createRequire } from "node:module";
import fs from "node:fs";
fs.mkdirSync("build", { recursive: true });

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const rounds = Number(process.argv[2] ?? 25);
const origin = process.argv[3] ?? "http://127.0.0.1:8000";
const setup = process.env.SOAK_SETUP ?? "apt-get install -y python";
const cmd = process.env.SOAK_CMD ?? "python3 -m compileall -q -f /usr/lib/python3.12 >/dev/null";

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
await page.goto(`${origin}/api.html`); // a page that boots nothing by itself
await page.evaluate(async () => {
  const { Winix } = await import("/winix.js");
  window.soak = { console: "", log: [], boots: 0 };
  window.soak.w = await Winix.boot({
    onConsole: (text) => { window.soak.console = (window.soak.console + text).slice(-200000); },
    onLog: (line) => { if (/Starting cpu 0 /.test(line)) window.soak.boots++; window.soak.log.push(line); },
  });
});

const exec = (command, timeoutMs) => page.evaluate(async ([command, timeoutMs]) => {
  const boots = window.soak.boots;
  try {
    const r = await window.soak.w.exec(command, { timeoutMs });
    return { ...r, rebuilt: window.soak.boots !== boots };
  } catch (e) {
    return { error: String(e.message || e), rebuilt: window.soak.boots !== boots };
  }
}, [command, timeoutMs]);

const results = [];
let failed = null;
const first = await exec(setup + " 2>&1", 300000);
if (first.error || first.exitCode !== 0) failed = { round: 0, ...first };
for (let i = 1; i <= rounds && !failed; i++) {
  const r = await exec(cmd, 600000);
  const bad = r.error || r.exitCode !== 0 || r.timedOut || r.rebuilt;
  results.push({ round: i, ms: Math.round(r.durationMs ?? 0), exitCode: r.exitCode, error: r.error, rebuilt: r.rebuilt });
  console.log(`${bad ? "FAIL" : "ok  "} round ${i}/${rounds}  ${Math.round((r.durationMs ?? 0) / 1000)} s` +
    (bad ? `  exit=${r.exitCode} timedOut=${r.timedOut} rebuilt=${r.rebuilt} ${r.error ?? ""}\n${(r.stderr ?? "").slice(-600)}` : ""));
  if (bad) failed = { round: i, ...r };
}
const mem = failed ? null : await exec("cat /proc/meminfo | head -4; grep -c . /proc/buddyinfo", 30000);
const consoleText = await page.evaluate(() => window.soak.console).catch(() => "");
await browser.close();

fs.writeFileSync("build/soak-results.json", JSON.stringify({ cmd, rounds, failed, results, errors: errors.slice(0, 20) }, null, 2));
if (failed || errors.length) fs.writeFileSync("build/soak-console.txt", consoleText);
if (mem?.stdout) console.log(mem.stdout.trim());
const panic = /Kernel panic[^\n]*/.exec(consoleText + "\n" + errors.join("\n"));
if (panic) console.log(panic[0]);
if (errors.length) console.log(`${errors.length} page error(s); first: ${errors[0].slice(0, 300)}`);
console.log(failed ? `FAILED in round ${failed.round}` : `${rounds} rounds passed`);
process.exit(failed || panic ? 1 : 0);
