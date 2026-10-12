/* Blink JIT backend for WebAssembly hosts (winix).
 *
 * Blink's JIT builds "paths": it records hot x86 code as a sequence of calls to
 * micro-ops (small C functions in uop.c etc.) plus register moves, through the
 * jit.h API, and on x86/ARM hosts encodes that as machine code. A wasm guest
 * cannot run machine code it writes, so here the same API records a small IR,
 * and a finished path is turned into a wasm module (one function), which the
 * page compiles and installs into this process's function table
 * (winix_jit_compile). The browser then compiles it to native code.
 *
 * - Host registers become i64 locals, numbered as on AArch64 (res0 == arg0),
 *   which Blink's recipes already support.
 * - Calls are typed call_indirects; the page reports each callee's wasm type by
 *   parsing this program's own module (winix_jit_fntype). Functions returning
 *   128-bit values take a hidden result pointer in the wasm C ABI.
 * - Blink's few raw ARM sequences (cbz/cbnz, cmp + b.cond, each skipping the
 *   following jump) are decoded into conditional skips; anything else raw
 *   abandons the path, leaving that code to the interpreter.
 * - A jump to another compiled path is a tail call (after checking for pending
 *   signals); a jump to a path that does not exist yet looks it up at run time.
 */
#ifdef __wasm__
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include "blink/assert.h"
#include "blink/jit.h"
#include "blink/machine.h"

const u8 kJitRes[2] = {kJitRes0, kJitRes1};
const u8 kJitSav[5] = {kJitSav0, kJitSav1, kJitSav2, kJitSav3, kJitSav4};
const u8 kJitArg[4] = {kJitArg0, kJitArg1, kJitArg2, kJitArg3};

extern int winix_jit_compile(const void *bytes, unsigned len);
extern long long winix_jit_fntype(unsigned fn);
bool WinixJitIsSret(uintptr_t fn);  // uop.c

enum {
  kIrEnter = 1,
  kIrSet,
  kIrMov,
  kIrCall,
  kIrJump,
  kIrJumpLazy,
  kIrRet,
  kIrTrap,
  kIrSkipZ,    // skip the next jump if reg == 0
  kIrSkipNz,   // skip the next jump if reg != 0
  kIrSkipCmp,  // skip the next jump if cond(a - b)
  kIrStash,    // if (m->stashaddr) CommitStash(m)
};

struct Ir {
  u8 op, a, b, wide;  // wide: 64-bit compare
  u32 cond;
  u64 x;
};

#define kIrMax (kJitBlockSize / sizeof(struct Ir))

static struct JitBlock g_jb;
static struct Ir *g_ir;
static bool g_poisoned;
static i64 g_lazy_virt;   // RecordJitJump() target for the next jump to ender
static uintptr_t g_staging;
static struct Jit *g_owner;  // exec creates the new System before freeing the old
static uintptr_t g_first_compiled;  // compiled paths are appended to the table
static u64 g_sret[2];

// Building a path costs a module compile, so only hot code gets one.
static unsigned g_hot = 3000;  // WINIX_JITHOT: below ~1000 startup costs more than it gains
static bool g_noinline;      // WINIX_JIT_NOINLINE
static struct {
  long started, abandoned, paths, failed, ops;
  double ms;
} g_stats;

static double NowMs(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec * 1e3 + ts.tv_nsec / 1e6;
}

static void PrintStats(void) {
  char b[160];
  snprintf(b, sizeof(b),
           "[blink wasm jit] started=%ld abandoned=%ld paths=%ld failed=%ld ops=%ld compile=%.0fms\n",
           g_stats.started, g_stats.abandoned, g_stats.paths, g_stats.failed, g_stats.ops, g_stats.ms);
  write(2, b, strlen(b));
}

////////////////////////////////////////////////////////////////////////////////
// hooks: guest address -> compiled path (or staging function)

struct Hook {
  i64 virt;
  uintptr_t fn;
  u32 count;  // times a path was requested here; one is built once it is hot
};
static struct Hook *g_hooks;
static unsigned g_hooks_cap, g_hooks_used;

static unsigned HookHash(i64 virt) {
  return (unsigned)(((u64)virt * 0x9e3779b97f4a7c15ull) >> 40);
}

static struct Hook *FindHook(i64 virt, bool create) {
  unsigned i, mask;
  if (!g_hooks) {
    if (!create) return 0;
    g_hooks_cap = 16384;
    unassert((g_hooks = (struct Hook *)calloc(g_hooks_cap, sizeof(*g_hooks))));
  }
  if (create && (g_hooks_used + 1) * 2 > g_hooks_cap) {
    struct Hook *old = g_hooks;
    unsigned oldcap = g_hooks_cap;
    g_hooks_cap *= 2;
    unassert((g_hooks = (struct Hook *)calloc(g_hooks_cap, sizeof(*g_hooks))));
    g_hooks_used = 0;
    for (i = 0; i < oldcap; ++i) {
      if (old[i].virt && old[i].fn) *FindHook(old[i].virt, true) = old[i];
    }
    free(old);
  }
  mask = g_hooks_cap - 1;
  for (i = HookHash(virt) & mask;; i = (i + 1) & mask) {
    if (g_hooks[i].virt == virt) return g_hooks + i;
    if (!g_hooks[i].virt) {
      if (!create) return 0;
      ++g_hooks_used;
      g_hooks[i].virt = virt;
      g_hooks[i].fn = 0;
      g_hooks[i].count = 0;
      return g_hooks + i;
    }
  }
}

static void SetHook(i64 virt, uintptr_t fn) {
  FindHook(virt, true)->fn = fn;
}

static void ForgetCells(void);

static void ClearHook(i64 virt) {
  struct Hook *h;
  if ((h = FindHook(virt, false)) && h->fn) {
    h->fn = 0;  // stays as a tombstone
    ForgetCells();
  }
}

uintptr_t GetJitHook(struct Jit *jit, u64 virt) {
  struct Hook *h = FindHook(virt, false);
  return h ? h->fn : 0;
}

// ExecuteInstruction's probe (machine.c): the function to run at virt (a
// compiled path, or the staging function while one is being built), else 0
// and whether virt has run often enough to be worth recording a path from.
uintptr_t WinixJitProbe(i64 virt, bool *hot) {
  struct Hook *h = FindHook(virt, true);
  if (h->fn) return h->fn;
  *hot = ++h->count >= g_hot;
  return 0;
}

static bool IsCompiled(uintptr_t fn) {
  return g_first_compiled && fn >= g_first_compiled;
}

// Called by generated code to find the compiled path at virt, if any.
static uintptr_t WinixJitTarget(i64 virt) {
  uintptr_t fn = GetJitHook(0, virt);
  return IsCompiled(fn) ? fn : 0;
}

// Each static jump to a path that did not exist when its own path was compiled
// gets a cell caching the target once found; generated code reads it, so the
// transition is a load and a tail call. Cells live in chunks that never move
// (their addresses are in generated code) and are zeroed when hooks change.
#define kCellChunk 4096
static u32 *g_cell_chunks[1024];
static unsigned g_cells;

static u32 *NewCell(void) {
  unsigned c = g_cells / kCellChunk;
  if (c >= 1024) return 0;
  if (!g_cell_chunks[c] && !(g_cell_chunks[c] = (u32 *)calloc(kCellChunk, sizeof(u32)))) return 0;
  return g_cell_chunks[c] + g_cells++ % kCellChunk;
}

static void ForgetCells(void) {
  for (unsigned c = 0; c * kCellChunk < g_cells; ++c) {
    memset(g_cell_chunks[c], 0, kCellChunk * sizeof(u32));
  }
}

int ResetJitPage(struct Jit *jit, i64 virt) {
  unsigned i;
  virt &= -4096;
  for (i = 0; i < g_hooks_cap; ++i) {
    if (g_hooks[i].virt && (g_hooks[i].virt & -4096) == virt) g_hooks[i].fn = 0;
  }
  ForgetCells();
  return 0;
}

////////////////////////////////////////////////////////////////////////////////
// lifecycle

int InitJit(struct Jit *jit, uintptr_t opt_staging_function) {
  memset(jit, 0, sizeof(*jit));
  g_owner = jit;
  g_staging = opt_staging_function;
  ForgetCells();
  free(g_hooks);
  g_hooks = 0;
  g_hooks_cap = g_hooks_used = 0;
  atomic_store_explicit(&jit->disabled, !!getenv("WINIX_NOJIT"), memory_order_release);
  if (getenv("WINIX_JITHOT")) g_hot = atoi(getenv("WINIX_JITHOT"));
  g_noinline = !!getenv("WINIX_JIT_NOINLINE");
  static bool stats;
  if (!stats && getenv("WINIX_JITSTATS")) stats = true, atexit(PrintStats);
  return 0;
}

int DestroyJit(struct Jit *jit) {
  if (jit != g_owner) return 0;
  g_owner = 0;
  free(g_hooks);
  g_hooks = 0;
  g_hooks_cap = g_hooks_used = 0;
  return 0;
}

int DisableJit(struct Jit *jit) {
  atomic_store_explicit(&jit->disabled, true, memory_order_release);
  return 0;
}

int EnableJit(struct Jit *jit) {
  atomic_store_explicit(&jit->disabled, false, memory_order_release);
  return 0;
}

int ShutdownJit(void) {
  return 0;
}
int FixJitProtection(struct Jit *jit) {
  return 0;
}
int FlushJit(struct Jit *jit) {
  return 0;
}
bool CanJitForImmediateEffect(void) {
  return true;
}
int CommitJit_(struct Jit *jit, struct JitBlock *jb) {
  return 0;
}
void ReinsertJitBlock_(struct Jit *jit, struct JitBlock *jb) {
}
bool RecordJitEdge(struct Jit *jit, i64 src, i64 dst) {
  return true;  // allow chaining; generated tail calls check for signals
}

////////////////////////////////////////////////////////////////////////////////
// recording

static bool Emit(struct JitBlock *jb, struct Ir ir) {
  long k = jb->index / sizeof(struct Ir);
  if (k >= (long)kIrMax) {
    jb->index = kJitBlockSize + 1;
    return false;
  }
  g_ir[k] = ir;
  jb->index += sizeof(struct Ir);
  return true;
}

struct JitBlock *StartJit(struct Jit *jit, i64 opt_virt) {
  if (IsJitDisabled(jit)) return 0;
  if (!g_ir && !(g_ir = (struct Ir *)malloc(kIrMax * sizeof(struct Ir)))) return 0;
  memset(&g_jb, 0, sizeof(g_jb));
  ++g_stats.started;
  g_jb.addr = (u8 *)g_ir;
  g_jb.virt = opt_virt;
  g_poisoned = false;
  g_lazy_virt = 0;
  if (opt_virt) SetHook(opt_virt, g_staging);
  return &g_jb;
}

bool AppendJit(struct JitBlock *jb, const void *data, long size) {
  u32 w0, w1;
  if (size == 4 || size == 8) memcpy(&w0, data, 4);
  if (size == 4 && w0 == kWasmEnter) return Emit(jb, (struct Ir){.op = kIrEnter});
  if (size == 4 && w0 == kWasmLeave) return true;
  // cbz / cbnz {w,x}<t>, #8
  if (size == 4 && (w0 & 0x7e000000u) == 0x34000000u && ((w0 >> 5) & 0x7ffff) == 2) {
    return Emit(jb, (struct Ir){.op = (w0 >> 24) & 1 ? kIrSkipNz : kIrSkipZ,
                                .a = w0 & 31, .wide = w0 >> 31});
  }
  // cmp {w,x}<n>, {w,x}<m> ; b.<cond> #8
  if (size == 8) {
    memcpy(&w1, (const u8 *)data + 4, 4);
    if ((w0 & 0x7f20fc1fu) == 0x6b00001fu && (w1 & 0xff000010u) == 0x54000000u &&  // cond in bits 0-3
        ((w1 >> 5) & 0x7ffff) == 2) {
      return Emit(jb, (struct Ir){.op = kIrSkipCmp, .a = (w0 >> 5) & 31,
                                  .b = (w0 >> 16) & 31, .wide = w0 >> 31,
                                  .cond = w1 & 15});
    }
  }
  g_poisoned = true;  // machine code we cannot translate: leave it to the interpreter
  return true;
}

bool AlignJit(struct JitBlock *jb, int align, int misalign) {
  return true;
}
bool AppendJitNop(struct JitBlock *jb) {
  return true;
}
bool AppendJitPause(struct JitBlock *jb) {
  return true;
}
bool AppendJitRet(struct JitBlock *jb) {
  return Emit(jb, (struct Ir){.op = kIrRet});
}
bool AppendJitTrap(struct JitBlock *jb) {
  return Emit(jb, (struct Ir){.op = kIrTrap});
}
bool AppendJitCall(struct JitBlock *jb, void *fn) {
  return Emit(jb, (struct Ir){.op = kIrCall, .x = (uintptr_t)fn});
}
bool AppendJitSetReg(struct JitBlock *jb, int reg, u64 value) {
  return Emit(jb, (struct Ir){.op = kIrSet, .a = reg, .x = value});
}
bool AppendJitMovReg(struct JitBlock *jb, int dst, int src) {
  return Emit(jb, (struct Ir){.op = kIrMov, .a = dst, .b = src});
}
bool AppendJitStashCheck(struct JitBlock *jb) {
  return Emit(jb, (struct Ir){.op = kIrStash});
}

bool RecordJitJump(struct JitBlock *jb, u64 virt, int addend) {
  g_lazy_virt = virt;  // turns the following jump to the ender into a lookup
  return true;
}

bool AppendJitJump(struct JitBlock *jb, void *code) {
  if ((uintptr_t)code == kWasmEnder && g_lazy_virt) {
    i64 virt = g_lazy_virt;
    g_lazy_virt = 0;
    return Emit(jb, (struct Ir){.op = kIrJumpLazy, .x = (u64)virt});
  }
  g_lazy_virt = 0;
  return Emit(jb, (struct Ir){.op = kIrJump, .x = (uintptr_t)code});
}

////////////////////////////////////////////////////////////////////////////////
// wasm encoding

struct Buf {
  u8 *p;
  size_t n, cap;
};

static void B1(struct Buf *b, u8 x) {
  if (b->n == b->cap) {
    b->cap = b->cap ? b->cap * 2 : 4096;
    unassert((b->p = (u8 *)realloc(b->p, b->cap)));
  }
  b->p[b->n++] = x;
}
static void BU(struct Buf *b, u64 x) {
  do {
    u8 c = x & 127;
    x >>= 7;
    B1(b, x ? c | 128 : c);
  } while (x);
}
static void BS(struct Buf *b, i64 x) {
  for (;;) {
    u8 c = x & 127;
    x >>= 7;
    if ((!x && !(c & 64)) || (x == -1 && (c & 64))) {
      B1(b, c);
      return;
    }
    B1(b, c | 128);
  }
}
static void BN(struct Buf *b, const void *p, size_t n) {
  for (size_t i = 0; i < n; ++i) B1(b, ((const u8 *)p)[i]);
}
static void BSection(struct Buf *mod, u8 id, struct Buf *sec) {
  B1(mod, id);
  BU(mod, sec->n);
  BN(mod, sec->p, sec->n);
  sec->n = 0;
}
static void BMem(struct Buf *b, u8 op, int align, u32 off) {
  B1(b, op);
  BU(b, align);
  BU(b, off);
}

// value types as reported by winix_jit_fntype: 0 i32, 1 i64, 2 f32, 3 f64
static const u8 kValType[4] = {0x7f, 0x7e, 0x7d, 0x7c};

#define kMaxTypes 64
static long long g_types[kMaxTypes];  // module-local type table (by signature)
static int g_ntypes;

static int TypeIndex(long long sig) {
  for (int i = 0; i < g_ntypes; ++i) {
    if (g_types[i] == sig) return i;
  }
  if (g_ntypes == kMaxTypes) return -1;
  g_types[g_ntypes] = sig;
  return g_ntypes++;
}

// signature encoding: bits 0-3 params, 4-5 results, 8+2k param k, 40-41 result
#define SIG(np, nr) ((long long)(np) | (long long)(nr) << 4)
#define SIGP(k, t)  ((long long)(t) << (8 + 2 * (k)))
#define SIGR(t)     ((long long)(t) << 40)
static const long long kSigPath =
    SIG(4, 0) | SIGP(0, 0) | SIGP(1, 1) | SIGP(2, 1) | SIGP(3, 1);
static const long long kSigTarget = SIG(1, 1) | SIGP(0, 1) | SIGR(0);
static const long long kSigStash = SIG(1, 0) | SIGP(0, 0);

static void EmitType(struct Buf *sec, long long sig) {
  int np = sig & 15, nr = (sig >> 4) & 3;
  B1(sec, 0x60);
  BU(sec, np);
  for (int k = 0; k < np; ++k) B1(sec, kValType[(sig >> (8 + 2 * k)) & 3]);
  BU(sec, nr);
  if (nr) B1(sec, kValType[(sig >> 40) & 3]);
}

// callee signatures, cached by function pointer
static struct {
  uintptr_t fn;
  long long sig;
} g_sigs[4096];

static long long FnSig(uintptr_t fn) {
  unsigned i = (unsigned)(fn * 2654435761u) & 4095;
  for (int k = 0; k < 4096; ++k, i = (i + 1) & 4095) {
    if (g_sigs[i].fn == fn) return g_sigs[i].sig;
    if (!g_sigs[i].fn) {
      g_sigs[i].fn = fn;
      return g_sigs[i].sig = winix_jit_fntype(fn);
    }
  }
  return winix_jit_fntype(fn);
}

#define LOCAL(r) (4 + (r))  // params 0..3 are (m, rde, disp, uimm0)

static void GetReg(struct Buf *b, int r) {
  B1(b, 0x20), BU(b, LOCAL(r));
}
static void SetRegFromStack(struct Buf *b, int r) {
  B1(b, 0x21), BU(b, LOCAL(r));
}

// return early (to the interpreter) when a signal or other event is pending
static void EmitAttentionExit(struct Buf *b) {
  B1(b, 0x20), BU(b, 0);
  BMem(b, 0x2d, 0, offsetof(struct Machine, attention));
  B1(b, 0x04), B1(b, 0x40), B1(b, 0x0f), B1(b, 0x0b);  // if return end
}

static void EmitTailCall(struct Buf *b, int pathtype) {
  // stack: table index (i32) is pushed by caller after args
  B1(b, 0x13), BU(b, pathtype), B1(b, 0x00);  // return_call_indirect
}

////////////////////////////////////////////////////////////////////////////////
// micro-op inlining
//
// The wasm counterpart of Blink copying a micro-op's machine code into a path:
// the page hands over the callee's wasm function body (from this program's own
// module), which is re-encoded into the path function inside a block. Its
// params and locals move to per-type local pools, `return` becomes a branch out
// of the block, __memory_base/__table_base become constants and
// __stack_pointer an imported global shared with the program. Bodies that call
// other functions or use anything else unusual keep the call_indirect.

extern int winix_jit_fnbody(unsigned fn, void *out, unsigned cap);
extern void winix_jit_bases(u32 *out);  // memory_base, table_base, and the
                                        // global indices of __stack_pointer,
                                        // __memory_base, __table_base

#define kPool        48
#define kMaxInline   768
#define POOL_I32     (LOCAL(32) + 1)  // after the i32 scratch
#define POOL_I64     (POOL_I32 + kPool)
#define POOL_F32     (POOL_I64 + kPool)
#define POOL_F64     (POOL_F32 + kPool)

static u32 g_bases[5];
static bool g_have_bases;

static struct {
  uintptr_t fn;
  int len;  // -1: not available
  u8 *body;
} g_bodies[2048];

static const u8 *FnBody(uintptr_t fn, int *len) {
  static u8 tmp[kMaxInline];
  unsigned i = (unsigned)(fn * 2654435761u) & 2047;
  for (int k = 0; k < 2048; ++k, i = (i + 1) & 2047) {
    if (g_bodies[i].fn == fn) break;
    if (!g_bodies[i].fn) {
      g_bodies[i].fn = fn;
      g_bodies[i].len = winix_jit_fnbody(fn, tmp, sizeof(tmp));
      if (g_bodies[i].len > 0 && (g_bodies[i].body = (u8 *)malloc(g_bodies[i].len))) {
        memcpy(g_bodies[i].body, tmp, g_bodies[i].len);
      } else {
        g_bodies[i].len = -1;
      }
      break;
    }
  }
  if (g_bodies[i].fn != fn || g_bodies[i].len <= 0) return 0;
  *len = g_bodies[i].len;
  return g_bodies[i].body;
}

static int PoolBase(u8 valtype) {
  switch (valtype) {
    case 0x7f: return POOL_I32;
    case 0x7e: return POOL_I64;
    case 0x7d: return POOL_F32;
    case 0x7c: return POOL_F64;
    default: return -1;
  }
}

static bool CopyLeb(struct Buf *o, const u8 *p, int n, int *i) {
  do {
    if (*i >= n) return false;
    B1(o, p[*i]);
  } while (p[(*i)++] & 0x80);
  return true;
}

static bool ReadU(const u8 *p, int n, int *i, u32 *x) {
  u32 r = 0;
  int s = 0;
  u8 c;
  do {
    if (*i >= n || s > 28) return false;
    c = p[(*i)++];
    r |= (u32)(c & 127) << s;
    s += 7;
  } while (c & 128);
  *x = r;
  return true;
}

// Re-encodes a function body's instructions (after its local declarations)
// into o; lmap maps the callee's local indices to ours.
static bool Reencode(struct Buf *o, const u8 *p, int n, int i, const int *lmap, int nlocals) {
  int depth = 0;
  u32 x, y;
  while (i < n) {
    u8 op = p[i++];
    switch (op) {
      case 0x00: case 0x01: case 0x05: case 0x1a: case 0x1b:  // unreachable nop else drop select
        B1(o, op);
        break;
      case 0x02: case 0x03: case 0x04:  // block loop if
        if (i >= n) return false;
        if (p[i] != 0x40 && PoolBase(p[i]) < 0) return false;  // only [] or one value
        B1(o, op), B1(o, p[i++]);
        ++depth;
        break;
      case 0x0b:  // end
        B1(o, op);
        if (!depth--) return i == n;  // the body's own end closes our block
        break;
      case 0x0c: case 0x0d:  // br br_if
        B1(o, op);
        if (!CopyLeb(o, p, n, &i)) return false;
        break;
      case 0x0e:  // br_table
        B1(o, op);
        if (!ReadU(p, n, &i, &x)) return false;
        BU(o, x);
        for (y = 0; y <= x; ++y) {
          if (!CopyLeb(o, p, n, &i)) return false;
        }
        break;
      case 0x0f:  // return -> leave our block
        B1(o, 0x0c), BU(o, depth);
        break;
      case 0x1c:  // select t*
        B1(o, op);
        if (!ReadU(p, n, &i, &x) || i + (int)x > n) return false;
        BU(o, x);
        BN(o, p + i, x);
        i += x;
        break;
      case 0x20: case 0x21: case 0x22:  // local.get/set/tee
        if (!ReadU(p, n, &i, &x) || (int)x >= nlocals) return false;
        B1(o, op), BU(o, lmap[x]);
        break;
      case 0x23:  // global.get
        if (!ReadU(p, n, &i, &x)) return false;
        if (x == g_bases[2]) {
          B1(o, 0x23), BU(o, 0);
        } else if (x == g_bases[3]) {
          B1(o, 0x41), BS(o, (i32)g_bases[0]);
        } else if (x == g_bases[4]) {
          B1(o, 0x41), BS(o, (i32)g_bases[1]);
        } else {
          return false;
        }
        break;
      case 0x24:  // global.set: only the stack pointer
        if (!ReadU(p, n, &i, &x) || x != g_bases[2]) return false;
        B1(o, 0x24), BU(o, 0);
        break;
      case 0x41: case 0x42:  // i32/i64.const
        B1(o, op);
        if (!CopyLeb(o, p, n, &i)) return false;
        break;
      case 0x43:  // f32.const
        if (i + 4 > n) return false;
        B1(o, op), BN(o, p + i, 4), i += 4;
        break;
      case 0x44:  // f64.const
        if (i + 8 > n) return false;
        B1(o, op), BN(o, p + i, 8), i += 8;
        break;
      case 0xfc:  // saturating truncations, memory.copy/fill
        if (!ReadU(p, n, &i, &x)) return false;
        B1(o, op), BU(o, x);
        if (x <= 7) break;
        if (x == 10 && i + 2 <= n) {
          BN(o, p + i, 2), i += 2;
          break;
        }
        if (x == 11 && i + 1 <= n) {
          B1(o, p[i++]);
          break;
        }
        return false;
      case 0xfe:  // atomics
        if (!ReadU(p, n, &i, &x)) return false;
        B1(o, op), BU(o, x);
        if (x == 3) {  // atomic.fence
          if (i >= n) return false;
          B1(o, p[i++]);
          break;
        }
        if (!CopyLeb(o, p, n, &i) || !CopyLeb(o, p, n, &i)) return false;
        break;
      default:
        if (op >= 0x28 && op <= 0x3e) {  // loads and stores: memarg
          if (i >= n || (p[i] & 0x40)) return false;  // no multi-memory
          B1(o, op);
          if (!CopyLeb(o, p, n, &i) || !CopyLeb(o, p, n, &i)) return false;
        } else if (op >= 0x45 && op <= 0xc4) {  // numeric
          B1(o, op);
        } else {
          return false;  // calls, tables, references, SIMD, memory.size/grow, ...
        }
        break;
    }
  }
  return false;
}

// Inlines a call to fn taking arguments from arg0.. and setting res0.
static bool TryInline(struct Buf *b, uintptr_t fn, long long sig) {
  struct Buf code = {0};
  const u8 *p;
  int n, i = 0, np = sig & 15, nr = (sig >> 4) & 3, k, nlocals = 0;
  int lmap[256], used[4] = {0}, zero[256], nzero = 0;
  u32 groups, count;
  u8 type;
  if (g_noinline) return false;
  if (!g_have_bases) {
    winix_jit_bases(g_bases);
    g_have_bases = true;
  }
  if (!(p = FnBody(fn, &n))) return false;
  for (k = 0; k < np; ++k) {  // params (integer only; see EmitCall)
    type = ((sig >> (8 + 2 * k)) & 3) ? 0x7e : 0x7f;
    if (used[(PoolBase(type) - POOL_I32) / kPool] == kPool) return false;
    lmap[nlocals++] = PoolBase(type) + used[(PoolBase(type) - POOL_I32) / kPool]++;
  }
  if (!ReadU(p, n, &i, &groups)) return false;
  while (groups--) {
    if (!ReadU(p, n, &i, &count) || i >= n || PoolBase(p[i]) < 0) return false;
    type = p[i++];
    int t = (PoolBase(type) - POOL_I32) / kPool;
    if (count > 255 || nlocals + (int)count > 256 || used[t] + (int)count > kPool) return false;
    while (count--) {
      zero[nzero++] = nlocals;
      lmap[nlocals++] = PoolBase(type) + used[t]++;
    }
  }
  if (!Reencode(&code, p, n, i, lmap, nlocals)) {
    free(code.p);
    return false;
  }
  // arguments into the callee's param locals (last first, off the stack)
  for (k = 0; k < np; ++k) {
    GetReg(b, kJitArg0 + k);
    if (!((sig >> (8 + 2 * k)) & 3)) B1(b, 0xa7);
  }
  for (k = np; k--;) B1(b, 0x21), BU(b, lmap[k]);
  // fresh locals start at zero, as in a real call
  for (k = 0; k < nzero; ++k) {
    int l = lmap[zero[k]];
    if (l >= POOL_F64) {
      B1(b, 0x44), BN(b, "\0\0\0\0\0\0\0\0", 8);
    } else if (l >= POOL_F32) {
      B1(b, 0x43), BN(b, "\0\0\0\0", 4);
    } else if (l >= POOL_I64) {
      B1(b, 0x42), BS(b, 0);
    } else {
      B1(b, 0x41), BS(b, 0);
    }
    B1(b, 0x21), BU(b, l);
  }
  B1(b, 0x02), B1(b, nr ? kValType[(sig >> 40) & 3] : 0x40);  // block
  BN(b, code.p, code.n);                                       // ... end
  free(code.p);
  if (nr) {
    if (!((sig >> 40) & 3)) B1(b, 0xad);
    SetRegFromStack(b, kJitRes0);
  }
  return true;
}

static bool EmitCall(struct Buf *b, uintptr_t fn) {
  long long sig;
  int np, nr, k, first = 0, ti;
  bool sret;
  if ((sig = FnSig(fn)) < 0) return false;
  np = sig & 15;
  nr = (sig >> 4) & 3;
  for (k = 0; k < np; ++k) {
    if (((sig >> (8 + 2 * k)) & 3) >= 2) return false;  // floats: not via GPRs
  }
  if (nr && ((sig >> 40) & 3) >= 2) return false;
  sret = WinixJitIsSret(fn);
  if (!sret && TryInline(b, fn, sig)) return true;
  if (sret) {
    if (!np || nr) return false;
    B1(b, 0x41), BS(b, (i32)(uintptr_t)g_sret);
    first = 1;
  }
  for (k = first; k < np; ++k) {
    GetReg(b, kJitArg0 + (k - first));
    if (!((sig >> (8 + 2 * k)) & 3)) B1(b, 0xa7);  // i32.wrap_i64
  }
  if ((ti = TypeIndex(sig)) < 0) return false;
  B1(b, 0x41), BS(b, (i32)fn);
  B1(b, 0x11), BU(b, ti), B1(b, 0x00);  // call_indirect
  if (sret) {
    B1(b, 0x41), BS(b, 0), BMem(b, 0x29, 3, (u32)(uintptr_t)g_sret);
    SetRegFromStack(b, kJitRes0);
    B1(b, 0x41), BS(b, 0), BMem(b, 0x29, 3, (u32)(uintptr_t)g_sret + 8);
    SetRegFromStack(b, kJitRes1);
  } else if (nr) {
    if (!((sig >> 40) & 3)) B1(b, 0xad);  // i64.extend_i32_u
    SetRegFromStack(b, kJitRes0);
  }
  return true;
}

// pushes a register, wrapped to i32 for 32-bit compares
static void GetW(struct Buf *b, int r, bool w) {
  GetReg(b, r);
  if (!w) B1(b, 0xa7);
}

// pushes i32: does the condition of a skip hold?
static void EmitSkipCond(struct Buf *b, const struct Ir *ir) {
  bool w = ir->wide;
  switch (ir->op) {
    case kIrSkipZ:
    case kIrSkipNz:
      GetReg(b, ir->a);
      if (w) {
        B1(b, 0x50);  // i64.eqz
      } else {
        B1(b, 0xa7), B1(b, 0x45);  // i32.wrap_i64 i32.eqz
      }
      if (ir->op == kIrSkipNz) B1(b, 0x45);
      return;
    default:
      break;
  }
  // cmp a, b; b.cond -- flags of a - b
#define A_ GetW(b, ir->a, w)
#define B_ GetW(b, ir->b, w)
#define OP(op32, op64) B1(b, w ? (op64) : (op32))
  switch (ir->cond) {
    case 0x0: A_, B_, OP(0x46, 0x51); break;  // eq
    case 0x1: A_, B_, OP(0x47, 0x52); break;  // ne
    case 0x2: A_, B_, OP(0x4f, 0x5a); break;  // cs: a >=u b
    case 0x3: A_, B_, OP(0x49, 0x54); break;  // cc: a <u b
    case 0x8: A_, B_, OP(0x4b, 0x56); break;  // hi: a >u b
    case 0x9: A_, B_, OP(0x4d, 0x58); break;  // ls: a <=u b
    case 0xa: A_, B_, OP(0x4e, 0x59); break;  // ge
    case 0xb: A_, B_, OP(0x48, 0x53); break;  // lt
    case 0xc: A_, B_, OP(0x4a, 0x55); break;  // gt
    case 0xd: A_, B_, OP(0x4c, 0x57); break;  // le
    case 0x4:                                // mi: (a - b) < 0
    case 0x5:                                // pl
      A_, B_, OP(0x6b, 0x7d);                // sub
      if (w) {
        B1(b, 0x42), BS(b, 0), B1(b, 0x53);  // i64.lt_s
      } else {
        B1(b, 0x41), BS(b, 0), B1(b, 0x48);  // i32.lt_s
      }
      if (ir->cond == 0x5) B1(b, 0x45);
      break;
    case 0x6:  // vs: ((a ^ b) & (a ^ (a - b))) < 0
    case 0x7:  // vc
      A_, B_, OP(0x73, 0x85);   // xor
      A_, A_, B_, OP(0x6b, 0x7d), OP(0x73, 0x85);  // a ^ (a - b)
      OP(0x71, 0x83);           // and
      if (w) {
        B1(b, 0x42), BS(b, 0), B1(b, 0x53);
      } else {
        B1(b, 0x41), BS(b, 0), B1(b, 0x48);
      }
      if (ir->cond == 0x7) B1(b, 0x45);
      break;
    default:
      B1(b, 0x41), BS(b, 0);
      break;
  }
#undef A_
#undef B_
#undef OP
}

// if (scratch) tail-call the path in scratch; else return to the interpreter
static void EmitTailCallScratch(struct Buf *b, int pathtype) {
  B1(b, 0x20), BU(b, LOCAL(32));
  B1(b, 0x04), B1(b, 0x40);
  B1(b, 0x20), BU(b, 0);
  B1(b, 0x42), BS(b, 0), B1(b, 0x42), BS(b, 0), B1(b, 0x42), BS(b, 0);
  B1(b, 0x20), BU(b, LOCAL(32));
  EmitTailCall(b, pathtype);
  B1(b, 0x0b);
  B1(b, 0x0f);
}

static bool EmitJump(struct Buf *b, const struct Ir *ir, int pathtype, int targettype) {
  switch (ir->op) {
    case kIrRet:
      B1(b, 0x0f);
      return true;
    case kIrJump:
      EmitAttentionExit(b);
      if (ir->x != kWasmEnder && IsCompiled(ir->x)) {
        B1(b, 0x41), BS(b, (i32)ir->x);
        B1(b, 0x21), BU(b, LOCAL(32));
      } else {
        // The ender (the interpreter resumes at m->ip): dispatch to the path
        // there, if there is one, without the trip through the interpreter.
        B1(b, 0x20), BU(b, 0), BMem(b, 0x29, 3, offsetof(struct Machine, ip));
        B1(b, 0x41), BS(b, (i32)(uintptr_t)WinixJitTarget);
        B1(b, 0x11), BU(b, targettype), B1(b, 0x00);
        B1(b, 0x21), BU(b, LOCAL(32));
      }
      EmitTailCallScratch(b, pathtype);
      return true;
    case kIrJumpLazy: {
      u32 *cell = NewCell();
      EmitAttentionExit(b);
      if (cell) {
        B1(b, 0x41), BS(b, 0), BMem(b, 0x28, 2, (u32)(uintptr_t)cell);  // i32.load
        B1(b, 0x21), BU(b, LOCAL(32));
        B1(b, 0x20), BU(b, LOCAL(32)), B1(b, 0x45);  // if (!cached)
        B1(b, 0x04), B1(b, 0x40);
      }
      B1(b, 0x42), BS(b, (i64)ir->x);
      B1(b, 0x41), BS(b, (i32)(uintptr_t)WinixJitTarget);
      B1(b, 0x11), BU(b, targettype), B1(b, 0x00);
      B1(b, 0x21), BU(b, LOCAL(32));
      if (cell) {
        B1(b, 0x41), BS(b, 0), B1(b, 0x20), BU(b, LOCAL(32));
        BMem(b, 0x36, 2, (u32)(uintptr_t)cell);  // i32.store
        B1(b, 0x0b);
      }
      EmitTailCallScratch(b, pathtype);
      return true;
    }
    case kIrTrap:
      B1(b, 0x00);
      return true;
    default:
      return false;
  }
}

static uintptr_t Compile(long n) {
  long i;
  int pathtype, targettype, stashtype;
  uintptr_t fn;
  struct Buf mod = {0}, sec = {0}, body = {0};
  static const u8 kHeader[] = {0, 'a', 's', 'm', 1, 0, 0, 0};
  g_ntypes = 0;
  pathtype = TypeIndex(kSigPath);
  targettype = TypeIndex(kSigTarget);
  stashtype = TypeIndex(kSigStash);
  // locals: 32 i64 registers, an i32 scratch, then the inlining pools
  BU(&body, 5);
  BU(&body, 32), B1(&body, 0x7e);
  BU(&body, 1 + kPool), B1(&body, 0x7f);
  BU(&body, kPool), B1(&body, 0x7e);
  BU(&body, kPool), B1(&body, 0x7d);
  BU(&body, kPool), B1(&body, 0x7c);
  for (i = 0; i < n; ++i) {
    struct Ir *ir = g_ir + i;
    switch (ir->op) {
      case kIrEnter:
        B1(&body, 0x20), BU(&body, 0), B1(&body, 0xad);  // i64.extend_i32_u
        SetRegFromStack(&body, kJitSav0);
        break;
      case kIrSet:
        B1(&body, 0x42), BS(&body, (i64)ir->x);
        SetRegFromStack(&body, ir->a);
        break;
      case kIrMov:
        GetReg(&body, ir->b);
        SetRegFromStack(&body, ir->a);
        break;
      case kIrCall:
        if (!EmitCall(&body, ir->x)) goto Fail;
        break;
      case kIrStash:
        B1(&body, 0x20), BU(&body, 0);
        BMem(&body, 0x29, 3, offsetof(struct Machine, stashaddr));
        B1(&body, 0x50), B1(&body, 0x45);  // != 0
        B1(&body, 0x04), B1(&body, 0x40);
        B1(&body, 0x20), BU(&body, 0);
        B1(&body, 0x41), BS(&body, (i32)(uintptr_t)CommitStash);
        B1(&body, 0x11), BU(&body, stashtype), B1(&body, 0x00);
        B1(&body, 0x0b);
        break;
      case kIrSkipZ:
      case kIrSkipNz:
      case kIrSkipCmp:
        // execute the next jump only when the skip condition does not hold
        if (i + 1 >= n) goto Fail;
        EmitSkipCond(&body, ir);
        B1(&body, 0x45);                  // i32.eqz
        B1(&body, 0x04), B1(&body, 0x40);  // if
        if (!EmitJump(&body, ++ir, pathtype, targettype)) goto Fail;
        B1(&body, 0x0b);
        ++i;
        break;
      default:
        if (!EmitJump(&body, ir, pathtype, targettype)) goto Fail;
        break;
    }
  }
  B1(&body, 0x0b);  // end function (falling off the end returns to the interpreter)
  if (g_ntypes < 0) goto Fail;
  BN(&mod, kHeader, sizeof(kHeader));
  BU(&sec, g_ntypes);
  for (i = 0; i < g_ntypes; ++i) EmitType(&sec, g_types[i]);
  BSection(&mod, 1, &sec);
  BU(&sec, 3);  // imports: env.memory (shared), env.table, env.sp (the program's __stack_pointer)
  BU(&sec, 3), BN(&sec, "env", 3), BU(&sec, 6), BN(&sec, "memory", 6);
  B1(&sec, 0x02), B1(&sec, 0x03), BU(&sec, 0), BU(&sec, 65536);
  BU(&sec, 3), BN(&sec, "env", 3), BU(&sec, 5), BN(&sec, "table", 5);
  B1(&sec, 0x01), B1(&sec, 0x70), B1(&sec, 0x00), BU(&sec, 0);
  BU(&sec, 3), BN(&sec, "env", 3), BU(&sec, 2), BN(&sec, "sp", 2);
  B1(&sec, 0x03), B1(&sec, 0x7f), B1(&sec, 0x01);
  BSection(&mod, 2, &sec);
  BU(&sec, 1), BU(&sec, pathtype);
  BSection(&mod, 3, &sec);
  BU(&sec, 1), BU(&sec, 1), B1(&sec, 'f'), B1(&sec, 0x00), BU(&sec, 0);
  BSection(&mod, 7, &sec);
  BU(&sec, 1), BU(&sec, body.n), BN(&sec, body.p, body.n);
  BSection(&mod, 10, &sec);
  fn = (uintptr_t)winix_jit_compile(mod.p, mod.n);
  free(mod.p), free(sec.p), free(body.p);
  if (fn == (uintptr_t)-1 || !fn) return 0;
  if (!g_first_compiled) g_first_compiled = fn;
  return fn;
Fail:
  free(mod.p), free(sec.p), free(body.p);
  return 0;
}

////////////////////////////////////////////////////////////////////////////////
// finishing

static void WinixJitNever(P) {
  JitlessDispatch(A);
}

bool AbandonJit(struct Jit *jit, struct JitBlock *jb) {
  ++g_stats.abandoned;
  if (jb->virt) ClearHook(jb->virt);
  jb->index = jb->start = 0;
  return false;
}

bool FinishJit(struct Jit *jit, struct JitBlock *jb) {
  uintptr_t fn;
  if (!jb->virt) return AbandonJit(jit, jb);
  if (g_poisoned || jb->index > kJitBlockSize) {
    // Untranslatable: interpret this address for good instead of recording it
    // again on every visit. A distinct function (not the staging one), so other
    // paths that reach it end there rather than being abandoned too.
    AbandonJit(jit, jb);
    SetHook(jb->virt, (uintptr_t)WinixJitNever);
    return false;
  }
  double t0 = NowMs();
  fn = Compile(jb->index / sizeof(struct Ir));
  g_stats.ms += NowMs() - t0;
  if (!fn) return ++g_stats.failed, AbandonJit(jit, jb);
  ++g_stats.paths;
  g_stats.ops += jb->index / sizeof(struct Ir);
  SetHook(jb->virt, fn);
  jb->index = jb->start = 0;
  return true;
}
#endif /* __wasm__ */
