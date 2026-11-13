// Native git in the guest (packages/git.sh): commits, branches, a local clone (a child git process and a sideband
// thread), and, with WINIX_TEST_NET=1, an https clone from github.com through serve.mjs's /__wisp relay.
// Build first: scripts/build.sh packages ca-certificates git. Serve dist/ with `node scripts/serve.mjs dist 8000`,
// then: node tests/git.mjs [origin]
// Writes build/git-results.json. Env: PW_CHANNEL (e.g. msedge), PLAYWRIGHT_CORE (path to playwright-core).
import { createRequire } from "node:module";
import fs from "node:fs";
fs.mkdirSync("build", { recursive: true });

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const origin = process.argv[2] ?? "http://127.0.0.1:8000";
const net = process.env.WINIX_TEST_NET === "1";

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL });
let results = [], pageError = null;
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => { pageError = String(e); });
  await page.goto(`${origin}/api.html`); // a page that boots nothing by itself
  results = await page.evaluate(async (net) => {
    const { Winix, wisp } = await import("/winix.js");
    const out = [];
    const check = async (name, w, cmd, test, opts = {}) => {
      const t0 = performance.now();
      try {
        const r = await w.exec(cmd, { timeoutMs: 120000, cwd: "/work", ...opts });
        const ok = test(r);
        out.push({ name, ok, ms: performance.now() - t0, detail: ok ? "" : JSON.stringify(r).slice(0, 1200) });
      } catch (e) {
        out.push({ name, ok: false, ms: performance.now() - t0, detail: String(e.message || e) });
      }
    };
    const w = await Winix.boot({ net: wisp("/__wisp") });
    await check("apt-get install git", w, "apt-get install -y git 2>&1 && git --version", (r) => /^git version 2\./m.test(r.stdout),
      { timeoutMs: 180000 });
    await check("init, add, commit (maintenance runs without fork)", w,
      "git init -q demo && cd demo && git config user.email a@b.c && git config user.name t && echo one > a.txt && " +
      "git add a.txt && git commit -q -m first && echo two >> a.txt && git commit -q -am second && git log --format=%s | cat",
      (r) => r.exitCode === 0 && r.stdout === "second\nfirst\n");
    await check("diff, branch, checkout, merge", w,
      "cd demo && git diff HEAD~1 --stat | tail -1 && git checkout -q -b side && echo side > b.txt && git add b.txt && " +
      "git commit -q -m side && git checkout -q main && git merge -q side && ls && git status --short | wc -l",
      (r) => r.exitCode === 0 && /1 file changed, 1 insertion/.test(r.stdout) && r.stdout.endsWith("a.txt\nb.txt\n0\n"));
    await check("clone a local repository, then fetch a new commit", w,
      "git clone -q demo copy 2>&1 && cd demo && echo three >> a.txt && git commit -q -am third && cd ../copy && " +
      "git pull -q 2>&1 && git log --format=%s | head -1",
      (r) => r.exitCode === 0 && r.stdout === "third\n");
    await check("the machine survives fork() being unavailable", w, "cd demo && git gc -q 2>&1; echo rc=$?; echo alive",
      (r) => r.stdout.endsWith("rc=0\nalive\n"));
    if (net) {
      await check("https clone from github.com", w,
        "git clone -q --depth 1 https://github.com/octocat/Hello-World.git hw 2>&1 && cat hw/README",
        (r) => r.exitCode === 0 && r.stdout === "Hello World!\n", { timeoutMs: 180000 });
    }
    w.dispose();
    return out;
  }, net);
} finally {
  await browser.close();
}

fs.writeFileSync("build/git-results.json", JSON.stringify(results, null, 2));
for (const c of results) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}  (${Math.round(c.ms)} ms)${c.ok ? "" : "\n      " + c.detail}`);
if (pageError) console.log("[pageerror]", pageError);
process.exit(results.length && results.every((c) => c.ok) && !pageError ? 0 : 1);
