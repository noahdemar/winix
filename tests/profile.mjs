// CPU-profiles the guest: boots winix in a browser page, runs a setup command unprofiled, then starts the DevTools
// sampling profiler in every worker created by the measured command (each guest task is one worker), and after the
// given number of seconds reports where the busiest worker spent its time, by function.
// Usage: node tests/profile.mjs 'command' [top=30] [setup-command] [seconds=30] [url=http://127.0.0.1:8000/]
// A worker's profile is lost when its task exits, so make the command outlast the sampling window, e.g.
//   "python3 -c '...; import time; time.sleep(120)'".
// Env: PW_CHANNEL (e.g. msedge), PLAYWRIGHT_CORE (path to playwright-core). Needs scripts/serve.mjs (for /__proxy).
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const command = process.argv[2] ?? "true";
const top = Number(process.argv[3] ?? 30);
const setup = process.argv[4] ?? "true";
const seconds = Number(process.argv[5] ?? 30);
const url = process.argv[6] ?? "http://127.0.0.1:8000/";
const port = 9333;

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL, args: [`--remote-debugging-port=${port}`] });
const page = await browser.newPage();
await page.goto(url);

// Minimal raw CDP client with flat sessions, so requests can be addressed to worker sessions.
const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws = new WebSocket(webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 1;
const pending = new Map();
const handlers = [];
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method) {
    for (const h of handlers) h(msg);
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    setTimeout(() => pending.has(id) && (pending.delete(id), resolve({})), 10000); // e.g. the worker exited
  });

let armed = false;
const workers = new Map(); // sessionId -> url
handlers.push(async (msg) => {
  if (msg.method !== "Target.attachedToTarget") return;
  const { sessionId, targetInfo } = msg.params;
  send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
  if (targetInfo.type === "worker" && armed) {
    workers.set(sessionId, targetInfo.url);
    await send("Profiler.enable", {}, sessionId);
    await send("Profiler.setSamplingInterval", { interval: 1000 }, sessionId);
    await send("Profiler.start", {}, sessionId);
  }
});
const targets = (await send("Target.getTargets")).result.targetInfos;
const pageTarget = targets.find((t) => t.type === "page" && t.url.startsWith(url));
const pageSession = (await send("Target.attachToTarget", { targetId: pageTarget.targetId, flatten: true })).result.sessionId;
await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, pageSession);

await page.evaluate(async (cmd) => {
  const { Winix, proxyFetch } = await import("/winix.js");
  window.__w = await Winix.boot({ fetch: proxyFetch() });
  await window.__w.exec(cmd, { timeoutMs: 600000 });
}, setup);
armed = true;
await page.evaluate((cmd) => {
  window.__run = window.__w.exec(cmd, { timeoutMs: 600000 });
}, command);
await new Promise((r) => setTimeout(r, seconds * 1000));

let best = null;
for (const [sessionId] of workers) {
  const profile = (await send("Profiler.stop", {}, sessionId)).result?.profile;
  if (!profile) continue;
  const idle = /^(lock_wait|(idle)|(program)|(root))$/;
  const total = profile.nodes.reduce((n, x) => n + (idle.test(x.callFrame.functionName || "(root)") ? 0 : x.hitCount || 0), 0);
  if (!best || total > best.total) best = { total, profile };
}
console.log(`profiled ${workers.size} workers`);
if (best) {
  const self = new Map();
  for (const n of best.profile.nodes) {
    const name = n.callFrame.functionName || `(${n.callFrame.url.split("/").pop() || "anonymous"})`;
    self.set(name, (self.get(name) || 0) + (n.hitCount || 0));
  }
  console.log(`busiest worker: ${best.total} samples`);
  for (const [name, hits] of [...self].sort((a, b) => b[1] - a[1]).slice(0, top)) {
    console.log(`${((100 * hits) / best.total).toFixed(1).padStart(5)}%  ${name}`);
  }
}
ws.close();
await browser.close();
