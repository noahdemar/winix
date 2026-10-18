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

`curl` (common flags: `-sSfLiIoOXHdAw`) asks the page to make the request with `fetch`,
so the browser's CORS rules apply. `proxyFetch()` sends cross-origin requests through `/__proxy?url=` on the dev
server instead; in production, point it at your own proxy (`proxyFetch('https://proxy.example/?url=')`) or pass any
`fetch`-compatible function.

## Sockets

The kernel has AF_INET TCP and UDP sockets (`patches/kernel/0005`, `arch/wasm/kernel/winixnet.c`) and AF_UNIX. There
is no IP stack: each socket is a channel the page relays (`src/net.js`) through the `net` transport passed to boot, normally
a [WISP](https://github.com/MercuryWorkshop/wisp-protocol) WebSocket server that makes the real connections:

```js
import { Winix, wisp } from './winix.js';
const w = await Winix.boot({ net: wisp('/__wisp') }); // scripts/serve.mjs serves a WISP endpoint at /__wisp
await w.exec('wget -q -O - http://example.com/ | head -c 100');
```

- DNS queries (UDP port 53, any address) are answered in the page with stand-in addresses from `198.18.0.0/15`;
  connecting to one connects to the name it stands for, so the WISP server does the real lookup.
- WISP does not acknowledge connections, so `connect()` succeeds at once and a refused or unreachable connection shows
  up as the error of the first `recv()` (and in `poll()` and `SO_ERROR`). BusyBox `nc` treats that as a normal exit.
- Guest programs can `listen` and `accept`. Connections to a listening port on `127.x`, `0.0.0.0` or the guest's
  `10.0.2.15` are paired in the page; `localhost` resolves to `127.0.0.1`. A `127.x` port with no guest listener goes
  to the WISP server, which reaches its own machine's localhost.
- The page can connect in (port forwarding): `w.connect(port)` gives a raw stream, and `w.guestFetch(port, path)`
  sends an HTTP request to a guest server and resolves to a `Response`:

  ```js
  await w.exec('python3 -m http.server 8080 >/tmp/log 2>&1 &');
  const res = await w.guestFetch(8080, '/');
  ```
- No IPv6. Over WISP there is no TCP half-close (`shutdown(SHUT_WR)` sends nothing); between guest sockets and to the
  page it works. BusyBox `nc` and `wget` (HTTP only) are enabled.
- TLS runs in the guest: `apt-get install -y python` gives Python's `ssl` (OpenSSL 3.5, statically linked), and
  `openssl` gives `openssl s_client`; both verify against Mozilla's roots in `/etc/ssl/cert.pem`. The page sets the
  guest's clock at boot (`date -s`), since it starts at 1970 and certificates would look not yet valid.
- Without `net`, connections fail with ENETUNREACH. `/__wisp` makes connections for anyone who can reach it, so in
  production point `wisp()` at your own server and restrict it.

Focused check (no internet needed): `node tests/net.mjs` with the server above running.

## Packages

`apt` (also `apt-get`, and `apk add`) installs packages in two tiers:

1. **Native (fast):** wasm builds from the recipes in `packages/`. `apt-get install -y sqlite` downloads
   `pkgs/sqlite_<ver>_<hash>.tar.gz` from next to the page (the guest's `winix://` URLs), checks its SHA-256 against
   `pkgs/index.txt`, and unpacks it at `/`. Archive names include a content hash, so browsers cache them forever.
   Available: `sqlite` (sqlite3), `lua`, `jq`, `zlib`, `python` (CPython 3.12 with `ssl` and `sqlite3`), `openssl`,
   `ca-certificates`, `blink`. Dependencies are installed first (`python` and `openssl` bring `ca-certificates`).
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
  - an **experimental register-only semantic tier** (`packages/blink-tracewasm.inc`), **opt-in** with
    `WINIX_JIT_TRACE=1`; `WINIX_JIT_NOTRACE=1` overrides it off. The default remains the original micro-op backend.
    The first prototype showed a small gain on a loop benchmark but a regression on mixed code in a single-sample
    check, so it is not on by default, and it is not near-native. Inside straight-line runs of supported
    instructions (MOV reg/reg, MOV immediate, ADD/OR/AND/SUB/XOR reg/reg and with imm8/imm32, all in 32- or 64-bit
    operand size), guest GPRs are kept in wasm locals and written back to Blink's register file before any other
    code runs. An ALU instruction's flags are not computed when a later supported ALU overwrites all of them before
    any barrier: this is a local, straight-line check, not a whole-function analysis. Otherwise the flags are
    computed in full, and they are written back to Blink's flag register at every barrier. Anything else (memory,
    8/16-bit, branches, calls, stash checks, other instructions) is a barrier: state is spilled and the original path
    runs. Without `WINIX_JIT_TRACE` the markers are ignored.
  - memory-operand `call *m` and `jmp *m` (`ff /2`, `ff /4`) are inlined under the same TLB guard: the effective
    address is computed from the instruction, the target is reread on every execution, and a cross-page operand, a
    missing permission, or a `0x67` address-size prefix falls back to Blink's op;
  - paths chain with tail calls, through per-site cache cells, and dispatch in place instead of returning to the
    interpreter; Blink's few raw ARM branch encodings are decoded into wasm conditionals;
  - finished paths are compiled in batches of up to 16 per module (`WINIX_JIT_BATCH`), since the browser's fixed
    cost per module outweighs compiling a path; a waiting path is interpreted, and the batch is flushed once its
    paths have been reached 256 times.
  Only code that runs 3,000 times gets a path (`WINIX_JITHOT`), and only where control arrives (an instruction
  reached by falling through cold code skips the lookup), so short commands pay nothing. Python: startup slightly
  faster (~0.95 s), CPU-bound loops ~4.5× faster, mixed code ~1.8×. `WINIX_NOJIT=1` turns it off,
  `WINIX_JITSTATS=1` prints counts, and `node tests/jitbench.mjs` compares the two.
  Focused regressions (exact output and exit in each JIT mode): run `scripts/build-jit-fixtures.sh` (WSL/Linux,
  host gcc; writes `dist/fixtures/` and the pages), serve `dist/` with `node scripts/serve.mjs dist 8000`, then
  `node tests/jit-indirect.mjs` (memory-operand call/jmp) and `node tests/jit-trace.mjs` (the experimental semantic
  tier: default, `WINIX_JIT_TRACE=1`, and `WINIX_JIT_TRACE=1 WINIX_JIT_NOTRACE=1`).
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

The server listens on localhost only, because `/__proxy` will fetch any URL and `/__wisp` will connect anywhere.

## Save and load a session

**Save Session** downloads a `.winix` file: a snapshot of the guest's filesystem (files, empty directories, modes,
owners, modification times, symlinks, and hard links), plus host state you supply. **Load Session** boots a new
machine from the file and swaps it in only if the restore succeeds.

- What is kept: the whole root filesystem except `/proc`, `/sys`, `/dev`, `/tmp` and `/run`, and except mounted and
  special files. Running programs, shell variables, terminal state and editor buffers are not kept. A session
  replaces the page's history with the one saved in the host state, not with a replay of commands.
- Writes are not frozen while saving. The save checks the filesystem before and after reading it, and fails if
  anything changed, so stop background programs and editors first.
- Trust: each chunk is checksummed, which detects corruption but does not prove who made the file. Sessions can
  contain secrets such as `.env` files and keys. They are not encrypted.
- Compatibility: a session restores only into the same winix build (the same kernel and initramfs bytes) and variant.
- The format is in `src/session.js`; the guest side is `guest/session-fs.h`. Archives are validated before any machine
  starts. Limits: 512 MiB of files, 100000 entries, 32 MiB of manifest.

API: `await w.exportSession({ hostState, onProgress })` returns a Blob; `await Winix.restoreSession(file, options)`
returns a new instance (the caller's instance is not changed); `w.hostState` is a copy of the saved host state;
`w.keyInput(text)` types into the console.

Focused check: `node tests/session.mjs` (page `src/session-test.html`, served from `dist/`).

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
  Also `CONFIG_FILE_LOCKING` (upstream disables it; sqlite, git and pip need it), and `CONFIG_NET`/`CONFIG_UNIX` with
  host-relayed AF_INET sockets (see Sockets).
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
