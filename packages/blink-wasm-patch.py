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

edit(root + '/blink/machine.h', [
    ('  u64 icache[512][kInstructionBytes / 8];\n',
     '#ifdef __wasm__\n'
     '  // 512 direct-mapped entries thrash on large programs (CPython: a third of\n'
     '  // instructions re-decoded); 64K cut Python startup by ~30%.\n'
     '  u64 icache[65536][kInstructionBytes / 8];\n'
     '#else\n'
     '  u64 icache[512][kInstructionBytes / 8];\n'
     '#endif\n'),
    ('  struct MachineTlb tlb[32];             //\n',
     '#ifdef __wasm__\n'
     '  // Without linear memory every guest access goes through this TLB; 32\n'
     '  // entries miss constantly on real programs, each miss a page walk.\n'
     '  struct MachineTlb tlb[4096];\n'
     '#else\n'
     '  struct MachineTlb tlb[32];             //\n'
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


# ---- wasm JIT backend (blink/jitwasm.c, from packages/blink-jitwasm.c) ----
import os
here = os.path.dirname(os.path.abspath(__file__))


def wrap(p, cond):
    s = open(p).read()
    open(p, 'w').write('#if ' + cond + '\n' + s + '\n#endif\n')


edit(root + '/blink/builtin.h', [
    ('#if !defined(DISABLE_JIT) && (defined(__x86_64__) || defined(__aarch64__)) && \\\n',
     '#if !defined(DISABLE_JIT) &&                                                  \\\n'
     '    (defined(__x86_64__) || defined(__aarch64__) || defined(__wasm__)) &&    \\\n'),
    ('#if defined(HAVE_JIT) && defined(__GNUC__) && \\\n',
     '#if defined(HAVE_JIT) && defined(__GNUC__) && !defined(__wasm__) && \\\n'),
])
edit(root + '/blink/jit.h', [
    ('extern const u8 kJitRes[2];\n',
     '#ifdef __wasm__\n'
     '// jitwasm.c: markers path.c emits instead of machine code, and the ender\n'
     '#define kWasmEnter 0x7761736du\n'
     '#define kWasmLeave 0x6c656176u\n'
     '#define kWasmEnder ((uintptr_t)1)\n'
     'bool AppendJitStashCheck(struct JitBlock *);\n'
     'uintptr_t WinixJitProbe(i64, bool *);\n'
     'bool AppendJitGuestBegin(struct JitBlock *, u64, i64, u64);\n'
     'bool AppendJitGuestEnd(struct JitBlock *);\n'
     '#endif\n\n'
     'extern const u8 kJitRes[2];\n'),
])
wrap(root + '/blink/jit.c', '!defined(__wasm__)  // see jitwasm.c')
wrap(root + '/blink/jitflush.c', '!defined(__wasm__)  // see jitwasm.c')
open(root + '/blink/jitwasm.c', 'w').write(open(os.path.join(here, 'blink-jitwasm.c')).read())
open(root + '/blink/tracewasm.inc', 'w').write(open(os.path.join(here, 'blink-tracewasm.inc')).read())
# guest instruction spans for the semantic tier (blink-tracewasm.inc): markers only, ignored by the old paths
edit(root + '/blink/machine.c', [
    ('    AddPath_StartOp(A);\n    jitpc = GetJitPc(m->path.jb);\n',
     '    AddPath_StartOp(A);\n'
     '#ifdef __wasm__\n'
     '    AppendJitGuestBegin(m->path.jb, rde, disp, uimm0);\n'
     '#endif\n'
     '    jitpc = GetJitPc(m->path.jb);\n'),
    ('      AddPath_EndOp(A);\n    } else {\n',
     '      AddPath_EndOp(A);\n'
     '#ifdef __wasm__\n'
     '      AppendJitGuestEnd(m->path.jb);\n'
     '#endif\n'
     '    } else {\n'),
    ('      AddPath_EndOp(A);\n      STATISTIC(++path_elements_auto);\n',
     '      AddPath_EndOp(A);\n'
     '#ifdef __wasm__\n'
     '      AppendJitGuestEnd(m->path.jb);\n'
     '#endif\n'
     '      STATISTIC(++path_elements_auto);\n'),
])
edit(root + '/blink/path.c', [
    ('#endif /* __x86_64__ */\n#endif /* HAVE_JIT */\n\nlong GetPrologueSize(void) {\n#ifdef HAVE_JIT\n',
     '#elif defined(__wasm__)\n'
     'static const u32 kEnter[] = {kWasmEnter};\n'
     'static const u32 kLeave[] = {kWasmLeave};\n'
     '#endif /* __x86_64__ */\n#endif /* HAVE_JIT */\n\nlong GetPrologueSize(void) {\n'
     '#if defined(HAVE_JIT) && defined(__wasm__)\n'
     '  return 0;  // paths are functions, entered whole\n'
     '#elif defined(HAVE_JIT)\n'),
    ('  struct JitBlock *jb;\n  if (!s->ender) {\n',
     '  struct JitBlock *jb;\n'
     '#ifdef __wasm__\n'
     '  s->ender = kWasmEnder;  // a jump here is a return to the interpreter\n'
     '  return;\n'
     '#endif\n'
     '  if (!s->ender) {\n'),
    ('#else\n  Jitter(A,\n         "a1i"  // arg1 = pc\n         "q"    // arg0 = machine\n'
     '         "c",   // call function (EndOp)\n',
     '#elif !LOG_JIX && defined(__wasm__)\n'
     '  if (m->reserving) {\n'
     '    AppendJitStashCheck(m->path.jb);\n'
     '  }\n'
     '#else\n  Jitter(A,\n         "a1i"  // arg1 = pc\n         "q"    // arg0 = machine\n'
     '         "c",   // call function (EndOp)\n'),
])
p = root + '/blink/fusion.c'
s = open(p).read()
assert s.count('#elif defined(__aarch64__)\n') == 2
open(p, 'w').write(s.replace('#elif defined(__aarch64__)\n',
                             '#elif defined(__aarch64__) || defined(__wasm__)  // jitwasm.c decodes these\n'))
with open(root + '/blink/uop.c', 'a') as f:
    f.write('''
#if defined(HAVE_JIT) && defined(__wasm__)
// In the wasm C ABI these return 128-bit values through a hidden pointer.
bool WinixJitIsSret(uintptr_t fn) {
  return fn == (uintptr_t)GetReg128 || fn == (uintptr_t)Load128;
}
#endif
''')

edit(root + '/blink/machine.c', [
    ('  unassert(m->canhalt);\n  if (CanJit(m)) {\n',
     '  unassert(m->canhalt);\n  if (CanJit(m)) {\n'
     '#ifdef __wasm__\n'
     '    // A path costs a module compile here, so cold code is interpreted with the\n'
     '    // lean dispatcher and paths are only recorded where execution is hot.\n'
     '    // Paths start where control arrives (branch targets, path exits), so an\n'
     '    // instruction reached by falling through a cold one skips the probe.\n'
     '    if (!IsMakingPath(m)) {\n'
     '      static i64 seq = -1;  // where the last cold instruction fell through to\n'
     '      bool hot = false;\n'
     '      i64 ip0 = m->ip;\n'
     '      if (ip0 != seq && (func = (nexgen32e_f)WinixJitProbe(ip0, &hot))) {\n'
     '        seq = -1;\n'
     '        func(DISPATCH_NOTHING);\n'
     '      } else if (hot) {\n'
     '        seq = -1;\n'
     '        GeneralDispatch(DISPATCH_NOTHING);\n'
     '      } else {\n'
     '        seq = -1;\n'
     '        JitlessDispatch(DISPATCH_NOTHING);\n'
     '        if (m->ip == ip0 + Oplength(m->xedd->op.rde)) seq = m->ip;\n'
     '      }\n'
     '      return;\n'
     '    }\n'
     '#endif\n'),
])
