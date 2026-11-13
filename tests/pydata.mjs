// numpy and pandas in the guest (packages/numpy.sh, packages/pandas.sh): extension modules loaded with dlopen.
// Build first: scripts/build.sh libcxx, then scripts/build.sh packages ca-certificates python numpy pandas.
// Serve dist/ with `node scripts/serve.mjs dist 8000`, then: node tests/pydata.mjs [origin]
// Writes build/pydata-results.json. Env: PW_CHANNEL (e.g. msedge), PLAYWRIGHT_CORE (path to playwright-core).
import { createRequire } from "node:module";
import fs from "node:fs";
fs.mkdirSync("build", { recursive: true });

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const origin = process.argv[2] ?? "http://127.0.0.1:8000";

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL });
let results = [], pageError = null;
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => { pageError = String(e); });
  await page.goto(`${origin}/api.html`); // a page that boots nothing by itself
  results = await page.evaluate(async () => {
    const { Winix } = await import("/winix.js");
    const out = [];
    const check = async (name, w, cmd, test, opts = {}) => {
      const t0 = performance.now();
      try {
        const r = await w.exec(cmd, { timeoutMs: 180000, cwd: "/work", ...opts });
        const ok = test(r);
        out.push({ name, ok, ms: performance.now() - t0, detail: ok ? "" : JSON.stringify(r).slice(0, 1500) });
      } catch (e) {
        out.push({ name, ok: false, ms: performance.now() - t0, detail: String(e.message || e) });
      }
    };
    const w = await Winix.boot();
    await check("apt-get install pandas (brings numpy and python)", w, "apt-get install -y pandas 2>&1 | tail -1",
      (r) => /Setting up pandas/.test(r.stdout), { timeoutMs: 300000 });
    await w.writeFile("/work/np.py", [
      "import numpy as np",
      "a = np.arange(12.0).reshape(3, 4)",
      "print(np.__version__.split('.')[0], a.sum(), a.T.shape, (a @ a.T)[0, 0])",
      "print(np.linalg.inv(np.array([[2., 1.], [1., 3.]])).round(3).tolist())",
      "print(np.linalg.eigvalsh(np.array([[2., 0.], [0., 3.]])).tolist())",
      "r = np.random.default_rng(0)",
      "x = r.random(100000)",
      "print(np.sort(x)[0] <= np.sort(x)[-1], abs(x.mean() - 0.5) < 0.01, x.dtype, np.argsort(np.array([3, 1, 2])).tolist())",
      "print(np.fft.fft(np.ones(4)).real.tolist(), np.array(['b', 'a']).astype('U')[::-1].tolist())",
      "print(np.frombuffer(np.arange(3, dtype='<i4').tobytes(), dtype='<i4').tolist(), float(np.float128(1) / 3) > 0.33)",
    ].join("\n"));
    await check("numpy: arrays, linear algebra, sorting, random, fft", w, "python3 np.py",
      (r) => r.exitCode === 0 && r.stdout === "2 66.0 (4, 3) 14.0\n[[0.6, -0.2], [-0.2, 0.4]]\n[2.0, 3.0]\n" +
        "True True float64 [1, 2, 0]\n[4.0, 0.0, 0.0, 0.0] ['a', 'b']\n[0, 1, 2] True\n");
    await w.writeFile("/work/sales.csv", "day,region,units,price\n2026-01-05,north,3,2.5\n2026-01-05,south,5,2.0\n" +
      "2026-01-06,north,4,2.5\n2026-01-07,south,,2.0\n2026-01-07,north,6,3.0\n");
    await w.writeFile("/work/pd.py", [
      "import pandas as pd",
      "df = pd.read_csv('sales.csv', parse_dates=['day'])",
      "df['revenue'] = df.units.fillna(0) * df.price",
      "print(pd.__version__.split('.')[0], df.shape, df.units.isna().sum(), df.day.dt.day_name().iloc[0])",
      "print(df.groupby('region').revenue.sum().to_dict())",
      "print(df.sort_values('revenue', ascending=False).region.tolist())",
      "print(df.rolling(2, on='day').units.mean().round(2).tolist()[:3])",
      "m = df.merge(pd.DataFrame({'region': ['north', 'south'], 'manager': ['ann', 'bo']}), on='region')",
      "print(m.pivot_table(index='manager', values='revenue', aggfunc='max').revenue.to_dict())",
      "print(pd.Timestamp('2026-03-29 12:00', tz='Europe/Stockholm').utcoffset().total_seconds())",
      "print(df.to_json(orient='records', date_format='iso')[:42])",
    ].join("\n"));
    await check("pandas: csv, groupby, sort, rolling, merge, pivot, time zones, json", w, "python3 pd.py",
      (r) => r.exitCode === 0 && r.stdout === "3 (5, 5) 1 Monday\n{'north': 35.5, 'south': 10.0}\n" +
        "['north', 'south', 'north', 'north', 'south']\n[nan, 4.0, 4.5]\n{'ann': 18.0, 'bo': 10.0}\n7200.0\n" +
        '[{"day":"2026-01-05T00:00:00.000","region"' + "\n");
    await check("a subprocess started after the extension modules are loaded", w,
      "python3 -c 'import pandas, subprocess; print(subprocess.run([\"echo\", \"child\"], capture_output=True, text=True).stdout.strip(), pandas.Series([1, 2]).sum())'",
      (r) => r.stdout === "child 3\n");
    w.dispose();
    return out;
  });
} finally {
  await browser.close();
}

fs.writeFileSync("build/pydata-results.json", JSON.stringify(results, null, 2));
for (const c of results) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}  (${Math.round(c.ms)} ms)${c.ok ? "" : "\n      " + c.detail}`);
if (pageError) console.log("[pageerror]", pageError);
process.exit(results.length && results.every((c) => c.ok) && !pageError ? 0 : 1);
