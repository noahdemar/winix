# winix

A real Linux kernel ([linux-wasm](https://github.com/joelseverin/linux-wasm), no-MMU `arch/wasm`) plus a wasm
userland (BusyBox, QuickJS, curl) running in the browser with no CPU emulation, behind a small JS API so agents can
run shell commands and scripts.

The API talks to a guest daemon (`winixd`) over `/dev/winix`, a binary channel device added to the kernel, so
there is no terminal scraping: `exec` costs about 40 ms, a 200 KB file transfer about 12 ms, and boot about 0.5 s.

```js
import { Winix, proxyFetch } from './winix.js';

const w = await Winix.boot({ fetch: proxyFetch() }); // ~0.5 s; fetch is used for guest curl requests
const r = await w.exec('echo hi; ls /bin | wc -l', { cwd: '/work', env: { FOO: '1' }, timeoutMs: 60000 });
// r = { stdout, stderr, exitCode, timedOut, truncated, durationMs }
await w.writeFile('/work/a.js', 'console.log(6 * 7)');
await w.exec('qjs /work/a.js');                      // QuickJS: ES2023, modules, std/os
await w.exec('curl -s https://example.com');         // HTTP(S) via the page's fetch
const bytes = await w.readFile('/work/a.js');        // Uint8Array, or { encoding: 'utf8' } for a string
await w.reset();                                     // fresh machine
w.dispose();
```

The filesystem persists between `exec` calls; shell variables do not (each call is a fresh `sh -c`). Calls are
queued and run one at a time. A timed-out command's process group is killed; the machine is only rebuilt if
`winixd` itself stops answering.

The guest has no sockets. `curl` (common flags: `-sSfLiIoOXHdAw`) asks the page to make the request with `fetch`,
so the browser's CORS rules apply. `proxyFetch()` sends cross-origin requests through `/__proxy?url=` on the dev
server instead; in production, point it at your own proxy (`proxyFetch('https://proxy.example/?url=')`) or pass any
`fetch`-compatible function.

## Packages

`apt` (also `apt-get`, and `apk add`) installs packages from the winix repository: wasm builds made from the
recipes in `packages/`, not Debian packages. `apt-get install -y sqlite` downloads `pkgs/sqlite_<ver>.tar.gz` from
next to the page (the guest's `winix://` URLs), checks its SHA-256 against `pkgs/index.txt`, and unpacks it at `/`.
Archives are versioned by name, so browsers can cache them indefinitely. Unknown packages fail the way apt does
(`E: Unable to locate package X`, exit 100). Point `WINIX_REPO` at another URL to use a different repository.

Available now: `sqlite` (sqlite3). Programs that use `setjmp`/`longjmp` (Lua, for one) trap with the current
toolchain, which has no wasm exception-handling support yet.

To add a package, write `packages/<name>.sh` (see `sqlite.sh`) and run `scripts/build.sh packages <name>`.

## Run it

The page must be cross-origin isolated (COOP/COEP) for `SharedArrayBuffer`; `scripts/serve.mjs` sets the headers.

```bash
node scripts/serve.mjs dist 8000
```

- http://127.0.0.1:8000/ is a command box on top of the API.
- http://127.0.0.1:8000/terminal.html is a full terminal (xterm.js; for vi, top, and so on).
- http://127.0.0.1:8000/test.html runs the API test suite in the page; bench.html prints latency numbers.

The server listens on localhost only, because `/__proxy` will fetch any URL.

## Tests

Both need a Chromium-based browser and `playwright-core` (set `PLAYWRIGHT_CORE` to its path and, for Edge,
`PW_CHANNEL=msedge`), with the server above running.

```bash
node tests/smoke.mjs
```

```bash
node tests/stress.mjs 30 build/stress.json
```

`stress.mjs` runs 30 fresh boots of the suite and classifies each as pass / panic / fail / hang.
`node tests/bench.mjs` prints boot, exec, process-start and file-transfer times.

## Build

`dist/` holds the built kernel and initramfs. To rebuild them, run from WSL (Ubuntu); the first build compiles
LLVM and takes a long time.

```bash
scripts/build.sh            # all | kernel | busybox | quickjs | guest
```

Changing only `src/` or `patches/runtime/` needs no rebuild: `scripts/copy-src.sh` refreshes `dist/`.

Our changes on top of upstream live in `patches/`:

- `kernel/`: a 256 KB user stack, max page order 14 (this fixed boot-time panics), and the `/dev/winix` device.
- `busybox/`: vfork-safe clone callbacks, plus the applet config.
- `quickjs/`: a port that runs without worker threads and with a small stack.
- `runtime/`: console output is sequenced across Web Workers and decoded as one byte stream; host side of
  `/dev/winix`.

`guest/` holds `winixd`, `curl` and the `/init` that starts `winixd`; `guest/winix-proto.h` defines the frame
format shared with `src/winix.js`.

See `docs/runtime-notes.md` for how the runtime works.
