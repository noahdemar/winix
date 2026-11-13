// UI check for Save Session / Load Session on the main page and the terminal (not a benchmark). Drives the real buttons,
// the download, the file chooser and the confirm dialogs, in a fresh browser context. Build first, then serve dist/.
// Usage: node tests/session-ui.mjs [base=http://127.0.0.1:8000/]
// Writes build/session-ui.json, build/session-ui.log lines on stdout, screenshots build/session-ui-*.png,
// and the saved sessions build/session-ui.winix and build/session-ui-terminal.winix.
// Env: PW_CHANNEL (e.g. msedge), PLAYWRIGHT_CORE (path to playwright-core).
import { createRequire } from "node:module";
import fs from "node:fs";
fs.mkdirSync("build", { recursive: true });

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const base = process.argv[2] ?? "http://127.0.0.1:8000/";
const BOOT_MS = 240000;
const checks = [];
const step = async (name, fn) => {
  try {
    const detail = await fn();
    checks.push({ name, ok: true, detail: detail ?? "" });
  } catch (e) {
    checks.push({ name, ok: false, detail: String(e?.message ?? e).slice(0, 400) });
  }
  const c = checks.at(-1);
  console.log(`${c.ok ? "PASS" : "FAIL"}  ${name}${c.ok ? "" : "  " + c.detail}`);
};
const check = (cond, msg) => { if (!cond) throw new Error(msg); };

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL });
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1000, height: 800 } });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

// Runs a command in the main page and returns the text of its entry once it has finished.
async function run(cmd) {
  await page.waitForFunction(() => !document.querySelector("#cmd").disabled, null, { timeout: BOOT_MS });
  await page.fill("#cmd", cmd);
  await page.press("#cmd", "Enter");
  await page.waitForFunction((c) => {
    const e = [...document.querySelectorAll(".entry")].at(-1);
    return e && e.querySelector(".cmd")?.textContent === c && !document.querySelector("#cmd").disabled;
  }, cmd, { timeout: BOOT_MS });
  return page.evaluate(() => [...document.querySelectorAll(".entry")].at(-1).textContent);
}

const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

// ---------------- main page ----------------
await page.goto(base + "index.html");
await step("main: boots and shows ready", async () => {
  await page.waitForFunction(() => document.querySelector("#status")?.textContent.includes("ready"), null, { timeout: BOOT_MS });
  return await page.textContent("#status");
});
await step("main: Save Session and Load Session visible and enabled", async () => {
  for (const sel of ["#save", "#load"]) {
    check(await page.isVisible(sel), `${sel} not visible`);
    check(await page.isEnabled(sel), `${sel} not enabled`);
  }
  check((await page.textContent("#save")).trim() === "Save Session", "Save label");
  check((await page.textContent("#load")).trim() === "Load Session", "Load label");
  check(await page.isVisible("text=Sessions save files only"), "files-only note missing");
});
await page.screenshot({ path: "build/session-ui-main-desktop.png", fullPage: true });
await step("main: a command writes a marker", async () => {
  const out = await run("echo ui-mark-1 > /work/m.txt && cat /work/m.txt");
  check(out.includes("ui-mark-1"), "marker not printed: " + out);
  return "ok";
});
let savedDownload = null;
await step("main: Save Session downloads a .winix file", async () => {
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: BOOT_MS }), page.click("#save")]);
  savedDownload = dl;
  check(/^winix-session-.*\.winix$/.test(dl.suggestedFilename()), "filename " + dl.suggestedFilename());
  await dl.saveAs("build/session-ui.winix");
  check(fs.statSync("build/session-ui.winix").size > 0, "empty download");
  await page.waitForFunction(() => document.querySelector("#session-status").textContent.startsWith("saved"), null, { timeout: 60000 });
  return dl.suggestedFilename();
});
await step("main: a change after the save is undone by Load Session", async () => {
  const out = await run("echo ui-mut > /work/m.txt && cat /work/m.txt");
  check(out.includes("ui-mut"), "mutation not visible: " + out);
  page.once("dialog", (d) => d.accept());
  const [fc] = await Promise.all([page.waitForEvent("filechooser"), page.click("#load")]);
  await fc.setFiles("build/session-ui.winix");
  await page.waitForFunction(() => document.querySelector("#session-status").textContent.startsWith("session restored"), null, { timeout: BOOT_MS });
  const after = await run("cat /work/m.txt");
  check(after.includes("ui-mark-1") && !after.includes("ui-mut"), "restored marker wrong: " + after);
  return "restored";
});
await step("main: restored history comes back (UpArrow) and saved output is shown as text", async () => {
  await page.focus("#cmd");
  await page.press("#cmd", "ArrowUp");
  check((await page.inputValue("#cmd")) === "cat /work/m.txt", "UpArrow gave: " + (await page.inputValue("#cmd")));
  await page.fill("#cmd", "");
  check(await page.isVisible("#log pre.saved"), "saved transcript is not in a <pre>");
  check((await page.textContent("#log pre.saved")).includes("ui-mark-1"), "saved transcript lost its text");
  return "ok";
});
await step("main: a bad file is rejected with an error and the current session keeps working", async () => {
  fs.writeFileSync("build/session-ui-bad.winix", "not a winix session");
  page.once("dialog", (d) => d.accept());
  const [fc] = await Promise.all([page.waitForEvent("filechooser"), page.click("#load")]);
  await fc.setFiles("build/session-ui-bad.winix");
  await page.waitForFunction(() => document.querySelector("#session-status").textContent.includes("load failed"), null, { timeout: BOOT_MS });
  const out = await run("cat /work/m.txt");
  check(out.includes("ui-mark-1"), "current session changed after a failed load: " + out);
  return await page.textContent("#session-status");
});
await step("main: cancelling the confirm leaves the current session alone", async () => {
  await run("echo before-cancel > /work/m.txt");
  page.once("dialog", (d) => d.dismiss());
  const [fc] = await Promise.all([page.waitForEvent("filechooser"), page.click("#load")]);
  await fc.setFiles("build/session-ui.winix");
  await page.waitForTimeout(1500);
  const out = await run("cat /work/m.txt");
  check(out.includes("before-cancel"), "cancelled load replaced the session: " + out);
  return "kept";
});
await step("main: layout at 320px has no horizontal overflow", async () => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.waitForTimeout(300);
  check(await noOverflow(), "horizontal overflow at 320px");
  await page.screenshot({ path: "build/session-ui-main-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1000, height: 800 });
  return "no overflow";
});

// ---------------- terminal ----------------
const term = await context.newPage();
term.on("pageerror", (e) => pageErrors.push("terminal: " + e));
await term.goto(base + "terminal.html");
const rows = () => term.evaluate(() => document.querySelector(".xterm-rows")?.textContent ?? "");
const typeLine = async (text) => {
  await term.click("#terminal");
  await term.keyboard.type(text, { delay: 5 });
  await term.keyboard.press("Enter");
};
await step("terminal: boots, buttons visible and enabled, layout fits 320px", async () => {
  await term.waitForFunction(() => document.querySelector("#status")?.textContent.startsWith("ready"), null, { timeout: BOOT_MS });
  for (const sel of ["#save", "#load"]) {
    check(await term.isVisible(sel), `${sel} not visible`);
    check(await term.isEnabled(sel), `${sel} not enabled`);
  }
  await term.setViewportSize({ width: 320, height: 700 });
  await term.waitForTimeout(300);
  check(await term.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "terminal overflows at 320px");
  await term.screenshot({ path: "build/session-ui-terminal-mobile.png" });
  await term.setViewportSize({ width: 1000, height: 800 });
  await term.waitForTimeout(300);
  return "ok";
});
await term.screenshot({ path: "build/session-ui-terminal.png" });
await step("terminal: keyboard input runs commands", async () => {
  await typeLine("echo tm$((1+1)) > /work/t.txt; cat /work/t.txt");
  await term.waitForFunction(() => (document.querySelector(".xterm-rows")?.textContent ?? "").includes("tm2"), null, { timeout: 120000 });
  return "tm2 printed";
});
let termDownload = null;
await step("terminal: Save Session downloads a .winix file", async () => {
  const [dl] = await Promise.all([term.waitForEvent("download", { timeout: BOOT_MS }), term.click("#save")]);
  termDownload = dl;
  await dl.saveAs("build/session-ui-terminal.winix");
  check(fs.statSync("build/session-ui-terminal.winix").size > 0, "empty download");
  return dl.suggestedFilename();
});
await step("terminal: a change is undone by Load Session, then keyboard input works", async () => {
  await typeLine("echo changed > /work/t.txt");
  await term.waitForTimeout(1500);
  term.once("dialog", (d) => d.accept());
  const [fc] = await Promise.all([term.waitForEvent("filechooser"), term.click("#load")]);
  await fc.setFiles("build/session-ui-terminal.winix");
  await term.waitForFunction(() => document.querySelector("#status")?.textContent.startsWith("session restored"), null, { timeout: BOOT_MS });
  await term.waitForTimeout(1500);
  await typeLine("cat /work/t.txt");
  await term.waitForFunction(() => (document.querySelector(".xterm-rows")?.textContent ?? "").includes("tm2"), null, { timeout: 120000 });
  return "restored";
});
await step("terminal: an invalid load keeps the current session and input", async () => {
  term.once("dialog", (d) => d.accept());
  const [fc] = await Promise.all([term.waitForEvent("filechooser"), term.click("#load")]);
  await fc.setFiles("build/session-ui-bad.winix");
  await term.waitForFunction(() => document.querySelector("#status")?.textContent.includes("load failed"), null, { timeout: BOOT_MS });
  await term.waitForTimeout(1000);
  await typeLine("echo still$((1+1))");
  await term.waitForFunction(() => (document.querySelector(".xterm-rows")?.textContent ?? "").includes("still2"), null, { timeout: 120000 });
  return "kept";
});

await browser.close();
const failed = checks.filter((c) => !c.ok);
console.log(`${checks.length - failed.length} of ${checks.length} checks passed`);
fs.writeFileSync("build/session-ui.json", JSON.stringify({ base, pageErrors, checks }, null, 2));
process.exit(failed.length ? 1 : 0);
