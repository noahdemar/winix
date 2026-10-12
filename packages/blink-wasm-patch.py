# Generates packages/blink-wasm.patch: run packages/blink-wasm-patch.sh from WSL after editing this file.
# Usage: python3 blink-wasm-patch.py <dir with a pristine blink-1.1.0 tree> (edits it in place).
import sys


def edit(p, pairs):
    s = open(p).read()
    for a, b in pairs:
        assert s.count(a) == 1, (p, s.count(a), a)
        s = s.replace(a, b)
    open(p, 'w').write(s)


root = sys.argv[1]
edit(root + '/blink/map.c', [
    ('  uint64_t want;\n  for (i = 16; i < 40; ++i) {',
     '  uint64_t want;\n#ifdef __wasm__\n'
     '  // NOMMU host: every fixed-address probe fails, and guest memory is never\n'
     '  // mapped linearly here, so assume the x86-64 layout.\n'
     '  return 47;\n#endif\n  for (i = 16; i < 40; ++i) {'),
    ('  int res = VfsMprotect(addr, length, prot);\n',
     '  int res = VfsMprotect(addr, length, prot);\n#ifdef __wasm__\n'
     "  // NOMMU host has no mprotect(); guest page permissions live in blink's own\n"
     '  // page tables (non-linear mode), so there is nothing to protect on the host.\n'
     '  if (res == -1 && errno == ENOSYS) res = 0;\n#endif\n'),
    ('  rc = VfsMunmap(addr, length);\n',
     '  rc = VfsMunmap(addr, length);\n#ifdef __wasm__\n'
     '  // NOMMU munmap() only takes whole mappings; blink frees sub-ranges. Leak them.\n'
     '  if (rc == -1 && errno == EINVAL) rc = 0;\n#endif\n'),
])
edit(root + '/blink/loader.c', [
    ('  img = VfsMmap(0, st.st_size, PROT_READ, MAP_SHARED, fd, 0);\n',
     '#ifdef __wasm__\n'
     '  // NOMMU: shared file mappings need physically contiguous page cache; a\n'
     '  // read-only private mapping (a copy) serves this peek just as well.\n'
     '  img = VfsMmap(0, st.st_size, PROT_READ, MAP_PRIVATE, fd, 0);\n'
     '#else\n'
     '  img = VfsMmap(0, st.st_size, PROT_READ, MAP_SHARED, fd, 0);\n'
     '#endif\n'),
    ('      if (ReserveVirtual(s, start, bulk, key, fd, offset, 0, 0) == -1) {\n'
     '        ERRF("failed to map elf program header file data");\n'
     '        exit(127);\n'
     '      }\n',
     '#ifdef __wasm__\n'
     '      // NOMMU host: per-page private file mmap()s are unreliable (pages that\n'
     '      // two segments share), so use anonymous memory and copy the file bytes.\n'
     '      if (ReserveVirtual(s, start, bulk, key, -1, 0, 0, 0) == -1) {\n'
     '        ERRF("failed to allocate elf program header memory");\n'
     '        exit(127);\n'
     '      }\n'
     '      LoaderCopy(m, start, filesz, image, offset, prot);\n'
     '#else\n'
     '      if (ReserveVirtual(s, start, bulk, key, fd, offset, 0, 0) == -1) {\n'
     '        ERRF("failed to map elf program header file data");\n'
     '        exit(127);\n'
     '      }\n'
     '#endif\n'),
])
WINIX_FORK = r'''
#ifdef __wasm__
// fork() on a NOMMU host (winix). There is no MMU to copy a process with, but
// the guest process is plain data here: registers plus blink's own page tables.
// So a fork streams a snapshot of it through a pipe into a freshly exec'd blink,
// which rebuilds it (WinixRestore) and resumes with rax=0. Host fds survive the
// exec; guest close-on-exec flags are cleared around the spawn and restored on
// both sides. vfork and clone(CLONE_VFORK) get the same copy semantics.
#include <sched.h>

#define WINIX_FORK_MAGIC 0x31464e5857ull

static bool g_winix_bad;

static void WinixPut(int fd, const void *p, size_t n) {
  const u8 *b = (const u8 *)p;
  while (n && !g_winix_bad) {
    ssize_t k = write(fd, b, n);
    if (k < 0 && errno == EINTR) continue;
    if (k <= 0) {
      g_winix_bad = true;
      break;
    }
    b += k;
    n -= k;
  }
}

static void WinixGet(int fd, void *p, size_t n) {
  u8 *b = (u8 *)p;
  while (n && !g_winix_bad) {
    ssize_t k = read(fd, b, n);
    if (k < 0 && errno == EINTR) continue;
    if (k <= 0) {
      g_winix_bad = true;
      memset(b, 0, n);
      break;
    }
    b += k;
    n -= k;
  }
}

static void WinixPutStr(int fd, const char *s) {
  u32 n = s ? strlen(s) + 1 : 0;
  WinixPut(fd, &n, 4);
  if (n) WinixPut(fd, s, n);
}

static char *WinixGetStr(int fd) {
  u32 n;
  char *s;
  WinixGet(fd, &n, 4);
  if (!n || g_winix_bad || !(s = (char *)malloc(n))) return 0;
  WinixGet(fd, s, n);
  s[n - 1] = 0;
  return s;
}

u64 HandlePageFault(struct Machine *, u8 *, u64);

// Every valid user-half leaf page: virt, permission key, and contents unless
// the page is an untouched anonymous reservation (still zero). File-backed
// reservations are mapped lazily on first touch, so fault them in first: the
// child would otherwise see zeros where the file's bytes belong.
static void WinixPutPages(struct Machine *m, int fd, u64 table, int level,
                          i64 base) {
  struct System *s = m->system;
  int i;
  u8 has, *t = GetPageAddress(s, table, level == 39);
  for (i = 0; i < (level == 39 ? 256 : 512); ++i) {
    u64 e = LoadPte(t + i * 8);
    i64 virt = base + ((i64)i << level);
    if (!(e & PAGE_V)) continue;
    if (level > 12) {
      WinixPutPages(m, fd, e, level - 9, virt);
      continue;
    }
    if ((e & PAGE_RSRV) && (e & PAGE_MAP)) {
      e = HandlePageFault(m, t + i * 8, e);
      if (!(e & PAGE_V)) continue;
    }
    u64 key = e & (PAGE_U | PAGE_RW | PAGE_XD);
    has = !(e & PAGE_RSRV);
    WinixPut(fd, &virt, 8);
    WinixPut(fd, &key, 8);
    WinixPut(fd, &has, 1);
    if (has) WinixPut(fd, GetPageAddress(s, e, false), 4096);
  }
}

static void WinixSnapshot(struct Machine *m, int fd, u64 flags, u64 stack,
                          u64 ctid) {
  struct Dll *e;
  struct System *s = m->system;
  u64 magic = WINIX_FORK_MAGIC, n = 0, sigmask = m->sigmask;
  i64 end = -1;
  WinixPut(fd, &magic, 8);
  WinixPut(fd, &flags, 8);
  WinixPut(fd, &stack, 8);
  WinixPut(fd, &ctid, 8);
  // CPU
  WinixPut(fd, &m->ip, sizeof(m->ip));
  WinixPut(fd, &m->mode, sizeof(m->mode));
  WinixPut(fd, &m->flags, sizeof(m->flags));
  WinixPut(fd, m->beg, sizeof(m->beg));
  WinixPut(fd, m->xmm, sizeof(m->xmm));
  WinixPut(fd, m->seg, sizeof(m->seg));
  WinixPut(fd, &m->fpu, sizeof(m->fpu));
  WinixPut(fd, &m->mxcsr, sizeof(m->mxcsr));
  WinixPut(fd, &sigmask, 8);
  WinixPut(fd, &m->sigaltstack, sizeof(m->sigaltstack));
  WinixPut(fd, &m->robust_list, sizeof(m->robust_list));
  // process
  WinixPut(fd, &s->mode, sizeof(s->mode));
  WinixPut(fd, &s->brk, sizeof(s->brk));
  WinixPut(fd, &s->automap, sizeof(s->automap));
  WinixPut(fd, &s->codestart, sizeof(s->codestart));
  WinixPut(fd, &s->codesize, sizeof(s->codesize));
  WinixPut(fd, s->hands, sizeof(s->hands));
  WinixPut(fd, &s->blinksigs, sizeof(s->blinksigs));
  WinixPut(fd, s->rlim, sizeof(s->rlim));
  WinixPut(fd, &s->exec_sigmask, sizeof(s->exec_sigmask));
  WinixPut(fd, &s->elf.base, sizeof(s->elf) - offsetof(struct Elf, base));
  WinixPutStr(fd, s->elf.prog);
  WinixPutStr(fd, s->elf.execfn);
  WinixPutStr(fd, s->elf.interpreter);
  // file descriptors
  for (e = dll_first(s->fds.list); e; e = dll_next(s->fds.list, e)) ++n;
  WinixPut(fd, &n, 8);
  for (e = dll_first(s->fds.list); e; e = dll_next(s->fds.list, e)) {
    struct Fd *f = FD_CONTAINER(e);
    WinixPut(fd, &f->fildes, sizeof(f->fildes));
    WinixPut(fd, &f->oflags, sizeof(f->oflags));
    WinixPut(fd, &f->socktype, sizeof(f->socktype));
    WinixPutStr(fd, f->path);
  }
  // memory
  WinixPutPages(m, fd, s->cr3, 39, 0);
  WinixPut(fd, &end, 8);
}

struct WinixSpawn {
  const char *path;
  char **argv;
  char **envp;
};

static int WinixSpawnChild(void *arg) {
  struct WinixSpawn *w = (struct WinixSpawn *)arg;
  execve(w->path, w->argv, w->envp);
  _exit(127);
}

static int WinixFork(struct Machine *m, u64 flags, u64 stack, u64 ctid) {
  static char self[PATH_MAX];
  struct Dll *e;
  struct WinixSpawn w;
  char fdenv[32], **envp, *argv[] = {(char *)"blink", 0};
  int p[2], pid, err, i, n = 0, nenv = 0, cleared[256];
  if (!*self && !realpath("/proc/self/exe", self)) strcpy(self, "/usr/bin/blink");
  if (pipe(p)) return -1;
  fcntl(p[1], F_SETFD, FD_CLOEXEC);
  for (e = dll_first(m->system->fds.list); e; e = dll_next(m->system->fds.list, e)) {
    int fd = FD_CONTAINER(e)->fildes;
    if (n < 256 && (fcntl(fd, F_GETFD) & FD_CLOEXEC) && !fcntl(fd, F_SETFD, 0)) {
      cleared[n++] = fd;
    }
  }
  while (environ[nenv]) ++nenv;
  if (!(envp = (char **)calloc(nenv + 2, sizeof(char *)))) return -1;
  memcpy(envp, environ, nenv * sizeof(char *));
  snprintf(fdenv, sizeof(fdenv), "BLINK_WINIX_FORK=%d", p[0]);
  envp[nenv] = fdenv;
  w.path = self;
  w.argv = argv;
  w.envp = envp;
#ifdef __wasm__
  pid = clone(WinixSpawnChild, 0, CLONE_VM | CLONE_VFORK | SIGCHLD, &w);
#else  // native test builds (-DWINIX_FORK): clone() needs a child stack
  static char stk[65536] __attribute__((__aligned__(16)));
  pid = clone(WinixSpawnChild, stk + sizeof(stk), CLONE_VM | CLONE_VFORK | SIGCHLD, &w);
#endif
  err = errno;
  for (i = 0; i < n; ++i) fcntl(cleared[i], F_SETFD, FD_CLOEXEC);
  free(envp);
  close(p[0]);
  if (pid < 0) {
    close(p[1]);
    errno = err;
    return -1;
  }
  g_winix_bad = false;
  WinixSnapshot(m, p[1], flags, stack, ctid);
  if (g_winix_bad) LOGF("fork snapshot: %s", DescribeHostErrno(errno));
  close(p[1]);
  return pid;
}

_Noreturn void WinixRestore(int fd, int (*exec)(char *, char *, char **, char **)) {
  struct Machine *m;
  struct System *s;
  u64 magic, flags, stack, ctid, n, i, key, sigmask;
  i64 virt, pid;
  u8 has, page[4096];
  _Atomic(i32) *ctid_ptr;
  unassert((g_machine = m = NewMachine(s = NewSystem(XED_MACHINE_MODE_LONG), 0)));
  s->exec = exec;
  s->cr0 = CR0_PE | CR0_MP | CR0_ET | CR0_PG;  // as LoadProgram() sets up paging
  s->cr3 = AllocatePageTable(s);
  g_winix_bad = false;
  WinixGet(fd, &magic, 8);
  if (magic != WINIX_FORK_MAGIC) {
    WriteErrorString("blink: bad fork snapshot\n");
    exit(127);
  }
  WinixGet(fd, &flags, 8);
  WinixGet(fd, &stack, 8);
  WinixGet(fd, &ctid, 8);
  WinixGet(fd, &m->ip, sizeof(m->ip));
  WinixGet(fd, &m->mode, sizeof(m->mode));
  WinixGet(fd, &m->flags, sizeof(m->flags));
  WinixGet(fd, m->beg, sizeof(m->beg));
  WinixGet(fd, m->xmm, sizeof(m->xmm));
  WinixGet(fd, m->seg, sizeof(m->seg));
  WinixGet(fd, &m->fpu, sizeof(m->fpu));
  WinixGet(fd, &m->mxcsr, sizeof(m->mxcsr));
  WinixGet(fd, &sigmask, 8);
  m->sigmask = sigmask;
  WinixGet(fd, &m->sigaltstack, sizeof(m->sigaltstack));
  WinixGet(fd, &m->robust_list, sizeof(m->robust_list));
  WinixGet(fd, &s->mode, sizeof(s->mode));
  WinixGet(fd, &s->brk, sizeof(s->brk));
  WinixGet(fd, &s->automap, sizeof(s->automap));
  WinixGet(fd, &s->codestart, sizeof(s->codestart));
  WinixGet(fd, &s->codesize, sizeof(s->codesize));
  WinixGet(fd, s->hands, sizeof(s->hands));
  WinixGet(fd, &s->blinksigs, sizeof(s->blinksigs));
  WinixGet(fd, s->rlim, sizeof(s->rlim));
  WinixGet(fd, &s->exec_sigmask, sizeof(s->exec_sigmask));
  WinixGet(fd, &s->elf.base, sizeof(s->elf) - offsetof(struct Elf, base));
  s->elf.prog = WinixGetStr(fd);
  s->elf.execfn = WinixGetStr(fd);
  s->elf.interpreter = WinixGetStr(fd);
  WinixGet(fd, &n, 8);
  for (i = 0; i < n && !g_winix_bad; ++i) {
    int fildes, oflags, socktype;
    struct Fd *f;
    char *path;
    WinixGet(fd, &fildes, sizeof(fildes));
    WinixGet(fd, &oflags, sizeof(oflags));
    WinixGet(fd, &socktype, sizeof(socktype));
    path = WinixGetStr(fd);
    if ((f = AddFd(&s->fds, fildes, oflags))) {
      f->socktype = socktype;
      f->path = path;
    }
    if (oflags & O_CLOEXEC) fcntl(fildes, F_SETFD, FD_CLOEXEC);
  }
  for (;;) {
    WinixGet(fd, &virt, 8);
    if (virt == -1 || g_winix_bad) break;
    WinixGet(fd, &key, 8);
    WinixGet(fd, &has, 1);
    if (ReserveVirtual(s, virt, 4096, PAGE_U | PAGE_RW, -1, 0, 0, 0) == -1) {
      WriteErrorString("blink: fork: out of memory\n");
      exit(127);
    }
    if (has) {
      WinixGet(fd, page, 4096);
      CopyToUser(m, virt, page, 4096);
    }
    if (key != (PAGE_U | PAGE_RW)) {
      ProtectVirtual(s, virt, 4096, GetProtection(key), false);
    }
  }
  close(fd);
  if (g_winix_bad) {
    WriteErrorString("blink: truncated fork snapshot\n");
    exit(127);
  }
  pid = getpid();
  m->tid = s->pid = pid;
  s->isfork = true;
  s->loaded = true;
  if (stack) Put64(m->sp, stack);
  if ((flags & (CLONE_CHILD_SETTID_LINUX | CLONE_CHILD_CLEARTID_LINUX)) &&
      !(ctid & (sizeof(i32) - 1)) &&
      (ctid_ptr = (_Atomic(i32) *)LookupAddress(m, ctid))) {
    if (flags & CLONE_CHILD_SETTID_LINUX) {
      atomic_store_explicit(ctid_ptr, Little32(pid), memory_order_release);
    }
    if (flags & CLONE_CHILD_CLEARTID_LINUX) m->ctid = ctid;
  }
  Put64(m->ax, 0);
  Blink(m);
}
#endif /* __wasm__ */
'''

edit(root + '/blink/syscall.c', [
    ('static int Fork(struct Machine *m, u64 flags, u64 stack, u64 ctid) {\n',
     '#ifdef __wasm__\nstatic int WinixFork(struct Machine *, u64, u64, u64);\n#endif\n\n'
     'static int Fork(struct Machine *m, u64 flags, u64 stack, u64 ctid) {\n'),
    ('  pid = fork();\n#ifdef __HAIKU__',
     '#ifdef __wasm__\n  pid = WinixFork(m, flags, stack, ctid);  // the parent side only\n#else\n'
     '  pid = fork();\n#endif\n#ifdef __HAIKU__'),
])
with open(root + '/blink/syscall.c', 'a') as f:
    f.write(WINIX_FORK)

edit(root + '/blink/blink.c', [
    ('int main(int argc, char *argv[]) {\n',
     '#ifdef __wasm__\n_Noreturn void WinixRestore(int, int (*)(char *, char *, char **, char **));\n#endif\n\n'
     'int main(int argc, char *argv[]) {\n'),
    ('  InitMap();\n  GetOpts(argc, argv);\n',
     '  InitMap();\n'
     '#ifdef __wasm__\n'
     '  if (getenv("BLINK_WINIX_FORK")) {  // we are the child of a snapshot fork\n'
     '    char *fake[] = {argv[0], (char *)"-", 0};\n'
     '    int fd = atoi(getenv("BLINK_WINIX_FORK"));\n'
     '    unsetenv("BLINK_WINIX_FORK");\n'
     '    GetOpts(2, fake);\n'
     '    if (SetOverlays(FLAG_overlays, true)) exit(127);\n'
     '    HandleSigs();\n'
     '    InitBus();\n'
     '    WinixRestore(fd, Exec);\n'
     '  }\n'
     '#endif\n'
     '  GetOpts(argc, argv);\n'),
])

WINIX_JIT = r'''
#ifdef __wasm__
// Block compiler for wasm hosts (winix). Blink's own JIT emits x86/ARM machine
// code, which a wasm guest cannot run. Instead, hot straight-line x86 code is
// compiled into a small wasm function that calls the same per-instruction
// handlers the interpreter uses, with the decoded operands baked in as
// constants. That skips, for every instruction, the icache lookup and 15-byte
// compare, the opcode switch and the interpreter loop. The page installs the
// function (winix_jit_compile, a runtime import) into this process's function
// table; the browser compiles it to native code. After each instruction the
// block exits if ip went anywhere but the next instruction (a branch, a fault
// handled by longjmp, a rep iteration) or a signal is pending, so the handlers'
// semantics need no special knowledge here. Opt-in with WINIX_JIT=1: on its
// own it saves only ~10% (the per-instruction handlers dominate); it is the
// scaffolding (runtime hook, module emitter, block cache) for a real backend.

#include <time.h>

extern int winix_jit_compile(const void *bytes, unsigned len);

#define WJ_SLOTS 65536
#define WJ_MAX_INSNS 64

static int g_wj_hot = 64;  // executions before a block is compiled (WINIX_JITHOT)
static struct {
  long compiled, failed, runs, insns;
  double compile_ms;
} g_wjs;

static double WinixNowMs(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec * 1e3 + ts.tv_nsec / 1e6;
}

static void WinixJitStats(void) {
  char b[256];
  snprintf(b, sizeof(b),
           "[winix jit] compiled=%ld failed=%ld block-runs=%ld insns=%ld "
           "compile=%.0fms\n",
           g_wjs.compiled, g_wjs.failed, g_wjs.runs, g_wjs.insns, g_wjs.compile_ms);
  WriteErrorString(b);
}

struct WinixJitSlot {
  i64 ip;
  u32 fn;
  u16 count;
  u8 state;  // 0 empty, 1 counting, 2 compiled, 3 not compilable
};

static struct WinixJitSlot *g_wj;
static struct System *g_wj_system;
static int g_wj_off = -1;

struct WinixBuf {
  u8 *p;
  size_t n, cap;
};

static void WbByte(struct WinixBuf *b, u8 x) {
  if (b->n == b->cap) {
    b->cap = b->cap ? b->cap * 2 : 1024;
    unassert((b->p = (u8 *)realloc(b->p, b->cap)));
  }
  b->p[b->n++] = x;
}

static void WbU(struct WinixBuf *b, u64 x) {
  do {
    u8 c = x & 127;
    x >>= 7;
    WbByte(b, x ? c | 128 : c);
  } while (x);
}

static void WbS(struct WinixBuf *b, i64 x) {
  for (;;) {
    u8 c = x & 127;
    x >>= 7;
    if ((!x && !(c & 64)) || (x == -1 && (c & 64))) {
      WbByte(b, c);
      return;
    }
    WbByte(b, c | 128);
  }
}

static void WbBytes(struct WinixBuf *b, const void *p, size_t n) {
  for (size_t i = 0; i < n; ++i) WbByte(b, ((const u8 *)p)[i]);
}

static void WbSection(struct WinixBuf *mod, u8 id, struct WinixBuf *sec) {
  WbByte(mod, id);
  WbU(mod, sec->n);
  WbBytes(mod, sec->p, sec->n);
  sec->n = 0;
}

// Memory/table access with memarg (alignment log2, offset); base is local 0 (m).
static void WbMem(struct WinixBuf *b, u8 op, int align, u32 off) {
  WbByte(b, op);
  WbU(b, align);
  WbU(b, off);
}

struct WinixInsn {
  u64 rde, uimm0;
  i64 disp, next;
  int len;
  uintptr_t handler;
  struct XedDecodedInst *xedd;
};

static u32 WinixJitEmit(struct Machine *m, struct WinixInsn *in, int n) {
  int i;
  u32 fn;
  struct WinixBuf mod = {0}, sec = {0}, body = {0};
  const u32 OFF_IP = offsetof(struct Machine, ip);
  const u32 OFF_OPLEN = offsetof(struct Machine, oplen);
  const u32 OFF_STASH = offsetof(struct Machine, stashaddr);
  const u32 OFF_ATTN = offsetof(struct Machine, attention);
  const u32 OFF_XEDD = offsetof(struct Machine, xedd);
  static const u8 kHeader[] = {0, 'a', 's', 'm', 1, 0, 0, 0};
  WbBytes(&mod, kHeader, sizeof(kHeader));
  // types: 0 = (i32) -> (), 1 = (i32, i64, i64, i64) -> () (opcode handlers)
  WbU(&sec, 2);
  WbByte(&sec, 0x60), WbU(&sec, 1), WbByte(&sec, 0x7f), WbU(&sec, 0);
  WbByte(&sec, 0x60), WbU(&sec, 4), WbByte(&sec, 0x7f), WbByte(&sec, 0x7e),
      WbByte(&sec, 0x7e), WbByte(&sec, 0x7e), WbU(&sec, 0);
  WbSection(&mod, 1, &sec);
  // imports: env.memory (shared, 0..65536 pages), env.table (funcref)
  WbU(&sec, 2);
  WbU(&sec, 3), WbBytes(&sec, "env", 3), WbU(&sec, 6), WbBytes(&sec, "memory", 6);
  WbByte(&sec, 0x02), WbByte(&sec, 0x03), WbU(&sec, 0), WbU(&sec, 65536);
  WbU(&sec, 3), WbBytes(&sec, "env", 3), WbU(&sec, 5), WbBytes(&sec, "table", 5);
  WbByte(&sec, 0x01), WbByte(&sec, 0x70), WbByte(&sec, 0x00), WbU(&sec, 0);
  WbSection(&mod, 2, &sec);
  WbU(&sec, 1), WbU(&sec, 0);  // one function of type 0
  WbSection(&mod, 3, &sec);
  WbU(&sec, 1), WbU(&sec, 1), WbByte(&sec, 'f'), WbByte(&sec, 0x00), WbU(&sec, 0);
  WbSection(&mod, 7, &sec);
  // body
  WbU(&body, 0);                           // no locals
  WbByte(&body, 0x02), WbByte(&body, 0x40);  // block
  for (i = 0; i < n; ++i) {
    // m->xedd = &copy; m->oplen = len; m->ip += len
    WbByte(&body, 0x20), WbU(&body, 0), WbByte(&body, 0x41), WbS(&body, (i32)(uintptr_t)in[i].xedd);
    WbMem(&body, 0x36, 2, OFF_XEDD);
    WbByte(&body, 0x20), WbU(&body, 0), WbByte(&body, 0x41), WbS(&body, in[i].len);
    WbMem(&body, 0x3a, 0, OFF_OPLEN);
    WbByte(&body, 0x20), WbU(&body, 0), WbByte(&body, 0x20), WbU(&body, 0);
    WbMem(&body, 0x29, 3, OFF_IP);
    WbByte(&body, 0x42), WbS(&body, in[i].len), WbByte(&body, 0x7c);
    WbMem(&body, 0x37, 3, OFF_IP);
    // handler(m, rde, disp, uimm0)
    WbByte(&body, 0x20), WbU(&body, 0);
    WbByte(&body, 0x42), WbS(&body, (i64)in[i].rde);
    WbByte(&body, 0x42), WbS(&body, in[i].disp);
    WbByte(&body, 0x42), WbS(&body, (i64)in[i].uimm0);
    WbByte(&body, 0x41), WbS(&body, (i32)in[i].handler);
    WbByte(&body, 0x11), WbU(&body, 1), WbByte(&body, 0x00);
    // if (m->stashaddr) CommitStash(m)
    WbByte(&body, 0x20), WbU(&body, 0), WbMem(&body, 0x29, 3, OFF_STASH);
    WbByte(&body, 0x50), WbByte(&body, 0x45);  // i64.eqz, i32.eqz
    WbByte(&body, 0x04), WbByte(&body, 0x40);  // if
    WbByte(&body, 0x20), WbU(&body, 0);
    WbByte(&body, 0x41), WbS(&body, (i32)(uintptr_t)CommitStash);
    WbByte(&body, 0x11), WbU(&body, 0), WbByte(&body, 0x00);
    WbByte(&body, 0x0b);
    // m->oplen = 0
    WbByte(&body, 0x20), WbU(&body, 0), WbByte(&body, 0x41), WbS(&body, 0);
    WbMem(&body, 0x3a, 0, OFF_OPLEN);
    if (i + 1 < n) {
      // exit unless execution fell through to the next instruction
      WbByte(&body, 0x20), WbU(&body, 0), WbMem(&body, 0x29, 3, OFF_IP);
      WbByte(&body, 0x42), WbS(&body, in[i].next), WbByte(&body, 0x52);
      WbByte(&body, 0x0d), WbU(&body, 0);
      WbByte(&body, 0x20), WbU(&body, 0), WbMem(&body, 0x2d, 0, OFF_ATTN);
      WbByte(&body, 0x0d), WbU(&body, 0);
    }
  }
  WbByte(&body, 0x0b);  // end block
  WbByte(&body, 0x0b);  // end function
  WbU(&sec, 1);
  WbU(&sec, body.n);
  WbBytes(&sec, body.p, body.n);
  WbSection(&mod, 10, &sec);
  fn = winix_jit_compile(mod.p, mod.n);
  free(mod.p);
  free(sec.p);
  free(body.p);
  return fn == (u32)-1 ? 0 : fn;
}

static bool WinixIsBlockEnd(u64 rde) {
  switch (Mopcode(rde)) {
    case 0x105:  // syscall
    case 0x0cc: case 0x0cd: case 0x0ce:  // int3, int, into
    case 0x0f4:  // hlt
    case 0x0cf:  // iret
    case 0x0e8: case 0x0e9: case 0x0eb:  // call, jmp
    case 0x0c2: case 0x0c3:  // ret
    case 0x0ff:  // group 5: only call/jmp (/2../5) transfer control; inc/dec/push do not
      return ModrmReg(rde) >= 2 && ModrmReg(rde) <= 5;
    case 0x10b:  // ud2
      return true;
    default:
      return false;
  }
}

static u32 WinixJitCompile(struct Machine *m, i64 ip) {
  int n = 0;
  u8 *page;
  i64 pc = ip;
  struct XedDecodedInst x;
  struct WinixInsn in[WJ_MAX_INSNS];
  if (!(page = LookupAddress2(m, ip & -4096, PAGE_XD, 0))) return 0;
  while (n < WJ_MAX_INSNS && (pc & 4095) + 15 <= 4096 && (pc & -4096) == (ip & -4096)) {
    if (DecodeInstruction(&x, page + (pc & 4095), 15, m->mode.omode)) break;
    in[n].rde = x.op.rde;
    in[n].disp = x.op.disp;
    in[n].uimm0 = x.op.uimm0;
    in[n].len = Oplength(x.op.rde);
    in[n].handler = (uintptr_t)GetOp(Mopcode(x.op.rde));
    if (in[n].handler == (uintptr_t)OpUd) break;
    if (!(in[n].xedd = (struct XedDecodedInst *)malloc(sizeof(x)))) break;
    memcpy(in[n].xedd, &x, sizeof(x));
    pc += in[n].len;
    in[n].next = pc;
    if (WinixIsBlockEnd(in[n++].rde)) break;
  }
  if (!n) return 0;
  double t0 = WinixNowMs();
  u32 fn = WinixJitEmit(m, in, n);
  g_wjs.compile_ms += WinixNowMs() - t0;
  if (fn) ++g_wjs.compiled, g_wjs.insns += n; else ++g_wjs.failed;
  return fn;
}

static struct WinixJitSlot *WinixJitSlot(i64 ip) {
  unsigned h = (unsigned)((ip ^ (ip >> 13)) * 0x9e3779b1u) & (WJ_SLOTS - 1);
  for (int i = 0; i < 8; ++i) {
    struct WinixJitSlot *s = g_wj + ((h + i) & (WJ_SLOTS - 1));
    if (!s->state || s->ip == ip) return s;
  }
  return g_wj + h;  // evict
}

static bool WinixJitRun(struct Machine *m) {
  struct WinixJitSlot *s;
  if (g_wj_off == -1) {
    g_wj_off = !getenv("WINIX_JIT");  // opt-in until it pays for itself
    if (getenv("WINIX_JITHOT")) g_wj_hot = atoi(getenv("WINIX_JITHOT"));
    if (getenv("WINIX_JITSTATS")) atexit(WinixJitStats);
    if (!g_wj_off && !(g_wj = (struct WinixJitSlot *)calloc(WJ_SLOTS, sizeof(*g_wj)))) g_wj_off = 1;
  }
  if (g_wj_off) return false;
  // Code changed or the process exec'd: everything compiled so far is stale.
  // (The xedd copies of dropped blocks leak; resets are rare.)
  if (g_wj_system != m->system ||
      atomic_load_explicit(&m->opcache->invalidated, memory_order_acquire)) {
    memset(g_wj, 0, WJ_SLOTS * sizeof(*g_wj));
    g_wj_system = m->system;
    return false;
  }
  s = WinixJitSlot(m->ip);
  if (s->state != 0 && s->ip != m->ip) memset(s, 0, sizeof(*s));
  switch (s->state) {
    case 2:
      ++g_wjs.runs;
      ((void (*)(struct Machine *))(uintptr_t)s->fn)(m);
      return true;
    case 3:
      return false;
    default:
      s->ip = m->ip;
      s->state = 1;
      if (++s->count == g_wj_hot) {
        s->fn = WinixJitCompile(m, m->ip);
        s->state = s->fn ? 2 : 3;
      }
      return false;
  }
}
#endif /* __wasm__ */

'''

edit(root + '/blink/machine.c', [
    ('void ExecuteInstruction(struct Machine *m) {\n', WINIX_JIT + 'void ExecuteInstruction(struct Machine *m) {\n'),
    ('#else\n  JitlessDispatch(DISPATCH_NOTHING);\n#endif\n}\n',
     '#else\n#ifdef __wasm__\n  if (WinixJitRun(m)) return;\n#endif\n  JitlessDispatch(DISPATCH_NOTHING);\n#endif\n}\n'),
])

edit(root + '/blink/machine.h', [
    ('  u64 icache[512][kInstructionBytes / 8];\n',
     '#ifdef __wasm__\n'
     '  // 512 direct-mapped entries thrash on large programs (CPython: a third of\n'
     '  // instructions re-decoded); 64K cut Python startup by ~30%.\n'
     '  u64 icache[65536][kInstructionBytes / 8];\n'
     '#else\n'
     '  u64 icache[512][kInstructionBytes / 8];\n'
     '#endif\n'),
])

edit(root + '/blink/memorymalloc.c', [
    ('                              memory_order_release);\n'
     '      }\n    }\n    UNLOCK(&s->machines_lock);\n  }\n#endif\n}\n',
     '                              memory_order_release);\n'
     '      }\n    }\n    UNLOCK(&s->machines_lock);\n  }\n#else\n'
     '  // Without threads there is one machine; it must still drop stale TLB and\n'
     '  // opcache entries (upstream did nothing here, so mprotect never took effect).\n'
     '  if (g_machine) {\n'
     '    if (tlb) g_machine->invalidated = true;\n'
     '    if (icache) g_machine->opcache->invalidated = true;\n'
     '  }\n#endif\n}\n'),
])
