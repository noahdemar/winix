# winix

A real Linux kernel ([linux-wasm](https://github.com/joelseverin/linux-wasm), no-MMU `arch/wasm`) plus a wasm
userland (BusyBox, QuickJS) running in the browser with no CPU emulation, behind a small JS API so agents can run
shell commands and scripts.

```js
import { Winix } from './winix.js';

const w = await Winix.boot();                        // ~1.3 s cold boot
const r = await w.exec('echo hi; ls /bin | wc -l', { cwd: '/work', env: { FOO: '1' }, timeoutMs: 60000 });
// r = { stdout, stderr, exitCode, timedOut, truncated, durationMs }
await w.writeFile('/work/a.js', 'console.log(6 * 7)');
await w.exec('qjs /work/a.js');                      // QuickJS: ES2023, modules, std/os
const bytes = await w.readFile('/work/a.js');        // Uint8Array, or { encoding: 'utf8' } for a string
await w.reset();                                     // fresh machine
w.dispose();
```

The filesystem persists between `exec` calls; shell variables do not (each call is a fresh `sh`). Calls are queued
and run one at a time. A timed-out command is killed and the machine is rebuilt.

## Run it

The page must be cross-origin isolated (COOP/COEP) for `SharedArrayBuffer`; `scripts/serve.mjs` sets the headers.

```bash
node scripts/serve.mjs dist 8000
```

- http://127.0.0.1:8000/ is an interactive BusyBox terminal.
- http://127.0.0.1:8000/test.html runs the API test suite in the page.

## Tests

Both need a Chromium-based browser and `playwright-core` (set `PLAYWRIGHT_CORE` to its path and, for Edge,
`PW_CHANNEL=msedge`), with the server above running.

```bash
node tests/smoke.mjs
```

```bash
node tests/stress.mjs 30 dist/stress.json
```

`stress.mjs` runs 30 fresh boots of the suite and classifies each as pass / panic / fail / hang.

## Build

`dist/` holds the built kernel and initramfs. To rebuild them, run from WSL (Ubuntu); the first build compiles
LLVM and takes a long time.

```bash
scripts/build.sh            # all | kernel | busybox | quickjs
```

Changing only `src/` or `patches/runtime/` needs no rebuild: `scripts/copy-src.sh` refreshes `dist/`.

Our changes on top of upstream live in `patches/`:

- `kernel/`: a 256 KB user stack, and max page order 14 (this fixed boot-time panics).
- `busybox/`: vfork-safe clone callbacks, plus the applet config.
- `quickjs/`: a port that runs without worker threads and with a small stack.
- `runtime/`: console output is sequenced across Web Workers and decoded as one byte stream.

See `docs/runtime-notes.md` for how the runtime works.
