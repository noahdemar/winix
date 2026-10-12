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

`apt` (also `apt-get`, and `apk add`) installs packages in two tiers:

1. **Native (fast):** wasm builds from the recipes in `packages/`. `apt-get install -y sqlite` downloads
   `pkgs/sqlite_<ver>_<hash>.tar.gz` from next to the page (the guest's `winix://` URLs), checks its SHA-256 against
   `pkgs/index.txt`, and unpacks it at `/`. Archive names include a content hash, so browsers cache them forever.
   Available: `sqlite` (sqlite3), `lua`, `blink`.
2. **Fallback (broad, slower):** anything else is resolved against Alpine Linux's x86-64 repositories (`main` and
   `community`, with dependencies), unpacked into `/opt/x86`, and given a wrapper in `/usr/bin` that runs it under
   [Blink](https://github.com/jart/blink), an x86-64 Linux user-mode emulator built as a winix package. So
   `apt-get install -y jq python3` works: real Alpine binaries, sharing the same files, pipes and processes. Expect
   them to be much slower than native packages (Python starts in about 1.5 s). Native commands are never shadowed.
   Set `WINIX_APT_FALLBACK=0` to turn this off, or `WINIX_ALPINE` to use another mirror or release.

Unknown packages fail the way apt does (`E: Unable to locate package X`, exit 100). Point `WINIX_REPO` at another
URL to use a different native repository.

Packages are built with `setjmp`/`longjmp` lowered to wasm exceptions (`guest/sjlj.c`; the guest libc's own
`longjmp` aborts), so interpreters that use them for errors work. To add a package, write `packages/<name>.sh` (see
`sqlite.sh`; plain `./configure && make` works, with a guest `cc` on `PATH`) and run
`scripts/build.sh packages <name>`.

### Blink on a no-MMU kernel

`packages/blink-wasm.patch` adapts Blink to this host (generated from `packages/blink-wasm-patch.py` by
`packages/blink-wasm-patch.sh`):

- `fork()` is a snapshot: the guest process is plain data in Blink (registers plus its own page tables), so it is
  streamed through a pipe into a freshly exec'd Blink that rebuilds it and resumes with `rax=0`. Host file
  descriptors carry over the exec. This gives x86 programs `fork`, `vfork`, pipes and `wait4`.
- ELF segments are copied into anonymous memory instead of `mmap`ped per page; host `mprotect`/partial `munmap`
  (unavailable without an MMU) become no-ops, since guest page permissions live in Blink's own page tables.
- Upstream bug: without threads, `InvalidateSystem` never flushed the TLB, so `mprotect` never took effect.
- **A wasm JIT backend** (`packages/blink-jitwasm.c`, built in as `blink/jitwasm.c`). Blink's JIT records hot x86
  code as calls to small micro-op functions; on x86/ARM it pastes their machine code together. Here a path becomes a
  wasm function instead, compiled by the page (`winix_jit_compile`) and called through the program's function table:
  - micro-ops are **inlined**: the page hands over their wasm bodies from Blink's own binary
    (`winix_jit_fnbody`), which are re-encoded into the path (locals renumbered, `return` turned into a branch);
  - other calls are typed `call_indirect`s, with types read from the binary (`winix_jit_fntype`);
  - guest memory lookups take an inline TLB fast path, and call Blink only on a miss (`WINIX_JIT_NOMEMFAST=1`
    disables it);
  - 64-bit push, pop, call, ret and register `call`/`jmp` use call-free fast versions with the same TLB check,
    falling back to Blink's op when it misses (`WINIX_JIT_NOSTACKFAST=1` disables them; Blink's own stack
    micro-ops need linear memory);
  - paths chain with tail calls, through per-site cache cells, and dispatch in place instead of returning to the
    interpreter; Blink's few raw ARM branch encodings are decoded into wasm conditionals;
  - finished paths are compiled in batches of up to 16 per module (`WINIX_JIT_BATCH`), since the browser's fixed
    cost per module outweighs compiling a path; a waiting path is interpreted, and the batch is flushed once its
    paths have been reached 256 times.
  Only code that runs 3,000 times gets a path (`WINIX_JITHOT`), and only where control arrives (an instruction
  reached by falling through cold code skips the lookup), so short commands pay nothing. Python: startup slightly
  faster (~0.95 s), CPU-bound loops ~4.5× faster, mixed code ~1.8×. `WINIX_NOJIT=1` turns it off,
  `WINIX_JITSTATS=1` prints counts, and `node tests/jitbench.mjs` compares the two.
- Bigger caches for a host without linear memory: a 64K-entry instruction cache (Python startup ~30% faster) and a
  4K-entry TLB.
- configure cannot run its probes when cross-compiling, so `packages/blink.sh` re-enables the features the guest
  libc and kernel have (`pipe2`, `dup3`, `wait4`, `preadv`, `getrandom`, ...).

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
`node tests/bench.mjs` prints boot, exec, process-start and file-transfer times. `node tests/profile.mjs CMD` samples
the guest with the DevTools profiler and prints where the busiest task spent its time.

## Build

`dist/` holds the built kernel and initramfs. To rebuild them, run from WSL (Ubuntu); the first build compiles
LLVM and takes a long time.

```bash
scripts/build.sh            # all | kernel | busybox | quickjs | guest
```

Changing only `src/` or `patches/runtime/` needs no rebuild: `scripts/copy-src.sh` refreshes `dist/`.

Our changes on top of upstream live in `patches/`:

- `kernel/`: a 256 KB user stack, max page order 14 (this fixed boot-time panics), and the `/dev/winix` device.
  Also `CONFIG_FILE_LOCKING` (upstream disables it; sqlite, git and pip need it).
- `musl/`: fixes the signal trampoline, which read `SA_SIGINFO`'s `info` pointer from address 8 instead of the
  signal frame, so every `sa_sigaction` handler trapped with a signature mismatch.
- `busybox/`: vfork-safe clone callbacks, plus the applet config.
- `quickjs/`: a port that runs without worker threads and with a small stack.
- `runtime/`: console output is sequenced across Web Workers and decoded as one byte stream; host side of
  `/dev/winix`; the exception tag packages use for `longjmp`; and signal delivery no longer crashes programs that
  never call `clone()` (it called their missing `__set_tls_base`).

`guest/` holds `winixd`, `curl` and the `/init` that starts `winixd`; `guest/winix-proto.h` defines the frame
format shared with `src/winix.js`.

See `docs/runtime-notes.md` for how the runtime works.
