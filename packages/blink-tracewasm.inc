// Register-only semantic tier for blink-jitwasm.c (included after EmitJump, before CompileBody).
//
// Inside a span that GeneralDispatch recorded for one supported guest instruction (see
// AppendJitGuestBegin), the instruction is emitted as wasm on guest locals GL(r) instead of the
// generic micro-op calls: GPRs are loaded from Machine.weg when first read and kept in locals while
// they are written, and the arithmetic flags are computed into a local. Everything else is a
// barrier: dirty GPRs and flags are spilled to Machine, and the locals are dropped, before any
// original IR, branch, return or call. The code is straight-line, so no state crosses a label.
// An ALU op's flags are computed unless a later supported ALU overwrites them before a barrier (see
// TrFlagsOverwritten); spilled flags are complete. Parity stays Blink's lazy LP byte.

#define GL(r) (POOL_F64 + kPool + (r))  // guest GPRs 0..15, flags 16, scratch 17..19
#define G_FLAGS 16
#define G_LHS 17
#define G_RHS 18
#define G_RES 19

// Flag bits a supported ALU instruction defines (CF AF ZF SF OF, and the lazy parity byte).
#define TR_CF 0x001u
#define TR_AF 0x010u
#define TR_ZF 0x040u
#define TR_SF 0x080u
#define TR_OF 0x800u
#define TR_ARITH (TR_CF | TR_AF | TR_ZF | TR_SF | TR_OF | 0xff000000u)

enum { TR_MOV = 1, TR_MOVI, TR_ALU, TR_ALUI };
enum { TR_ADD, TR_OR, TR_AND, TR_SUB, TR_XOR };

static struct {
  u32 valid;         // GPR i: GL(i) holds its value
  u32 dirty;         // GPR i: GL(i) is newer than Machine.weg
  bool flags_dirty;  // GL(G_FLAGS) holds arithmetic flags not yet in Machine.flags
  bool in_region;    // inside a run of semantic spans (trace_regions)
} g_tr;

struct TrInsn {
  int kind, aop, dst, src, w;
  bool regsrc;
};

static void TrLocal(struct Buf *b, int l) {
  B1(b, 0x20), BU(b, GL(l));
}

static void TrSetLocal(struct Buf *b, int l) {
  B1(b, 0x21), BU(b, GL(l));
}

// pushes guest register r, loading it from Machine on first use since the last barrier
static void TrGet(struct Buf *b, int r) {
  if (!(g_tr.valid >> r & 1)) {
    B1(b, 0x20), BU(b, 0);
    BMem(b, 0x29, 3, offsetof(struct Machine, weg) + 8 * r);
    TrSetLocal(b, r);
    g_tr.valid |= 1u << r;
  }
  TrLocal(b, r);
}

// pops an i64 into guest register r
static void TrPut(struct Buf *b, int r) {
  TrSetLocal(b, r);
  g_tr.valid |= 1u << r;
  g_tr.dirty |= 1u << r;
}

// Writes dirty guest state back to Machine. The locals stay valid; TrBarrier drops them.
static void TrSpill(struct Buf *b) {
  int r;
  const u32 foff = offsetof(struct Machine, flags);
  for (r = 0; r < 16; ++r) {
    if (!(g_tr.dirty >> r & 1)) continue;
    B1(b, 0x20), BU(b, 0);
    TrLocal(b, r);
    BMem(b, 0x37, 3, offsetof(struct Machine, weg) + 8 * r);
  }
  if (g_tr.flags_dirty) {  // m->flags = (m->flags & ~TR_ARITH) | (flags & TR_ARITH)
    B1(b, 0x20), BU(b, 0);
    B1(b, 0x20), BU(b, 0), BMem(b, 0x28, 2, foff);
    B1(b, 0x41), BS(b, (i32)~TR_ARITH), B1(b, 0x71);
    TrLocal(b, G_FLAGS), B1(b, 0xa7);
    B1(b, 0x41), BS(b, (i32)TR_ARITH), B1(b, 0x71), B1(b, 0x72);
    BMem(b, 0x36, 2, foff);
  }
  g_tr.dirty = 0;
  g_tr.flags_dirty = false;
}

// Any original code may read or write guest state: spill, then forget the locals.
static void TrBarrier(struct Buf *b) {
  TrSpill(b);
  g_tr.valid = 0;
  g_tr.in_region = false;
}

static const u8 kTrAluWasm[5] = {0x7c, 0x84, 0x83, 0x7d, 0x85};  // i64 add, or, and, sub, xor
static const u8 kTrAluFlags[5] = {0, 2, 2, 1, 2};                // 0 add, 1 sub, 2 logic

// pops an i64 and pushes its bit `sh` as 0 or 1
static void TrBit(struct Buf *b, int sh) {
  I64Const(b, sh), B1(b, 0x88);  // i64.shr_u
  I64Const(b, 1), B1(b, 0x83);   // i64.and
}

// pops a 0/1 bit and ORs it into the accumulator below it, at position pos
static void TrTerm(struct Buf *b, int pos) {
  I64Const(b, pos), B1(b, 0x86), B1(b, 0x84);  // i64.shl, i64.or
}

// G_FLAGS = the flag bits of the last ALU op, from G_LHS, G_RHS (masked to the width) and G_RES.
// sign is the width's sign bit. PF is not written: the lazy parity byte is the LP term.
static void TrFlags(struct Buf *b, int kind, int sign) {
  I64Const(b, 0);
  if (kind == 0) {  // CF = res <u lhs
    TrLocal(b, G_RES), TrLocal(b, G_LHS), B1(b, 0x54), B1(b, 0xad), TrTerm(b, 0);
  } else if (kind == 1) {  // CF = lhs <u rhs
    TrLocal(b, G_LHS), TrLocal(b, G_RHS), B1(b, 0x54), B1(b, 0xad), TrTerm(b, 0);
  }
  if (kind != 2) {  // AF = bit 4 of lhs ^ rhs ^ res
    TrLocal(b, G_LHS), TrLocal(b, G_RHS), B1(b, 0x85), TrLocal(b, G_RES), B1(b, 0x85);
    TrBit(b, 4), TrTerm(b, 4);
  }
  TrLocal(b, G_RES), B1(b, 0x50), B1(b, 0xad), TrTerm(b, 6);  // ZF = res == 0
  TrLocal(b, G_RES), TrBit(b, sign), TrTerm(b, 7);            // SF = sign of res
  if (kind == 0) {  // OF = sign of (lhs ^ res) & (rhs ^ res)
    TrLocal(b, G_LHS), TrLocal(b, G_RES), B1(b, 0x85);
    TrLocal(b, G_RHS), TrLocal(b, G_RES), B1(b, 0x85), B1(b, 0x83);
    TrBit(b, sign), TrTerm(b, 11);
  } else if (kind == 1) {  // OF = sign of (lhs ^ rhs) & (lhs ^ res)
    TrLocal(b, G_LHS), TrLocal(b, G_RHS), B1(b, 0x85);
    TrLocal(b, G_LHS), TrLocal(b, G_RES), B1(b, 0x85), B1(b, 0x83);
    TrBit(b, sign), TrTerm(b, 11);
  }
  TrLocal(b, G_RES), I64Const(b, 255), B1(b, 0x83), I64Const(b, 24), B1(b, 0x86), B1(b, 0x84);  // LP
  TrSetLocal(b, G_FLAGS);
  g_tr.flags_dirty = true;
}

// dst = dst op src (or imm), with the result zero-extended for 32-bit operands. The flags are only
// computed when flags_live; an elided set leaves the flag state as it was (see TrFlagsOverwritten).
static void TrAlu(struct Buf *b, const struct TrInsn *o, i64 imm, bool flags_live) {
  i64 m = o->w == 64 ? -1 : 0xffffffffLL;
  TrGet(b, o->dst), I64Const(b, m), B1(b, 0x83), TrSetLocal(b, G_LHS);
  if (o->regsrc) {
    TrGet(b, o->src), I64Const(b, m), B1(b, 0x83);
  } else {
    I64Const(b, imm & m);
  }
  TrSetLocal(b, G_RHS);
  TrLocal(b, G_LHS), TrLocal(b, G_RHS), B1(b, kTrAluWasm[o->aop]);
  I64Const(b, m), B1(b, 0x83), TrSetLocal(b, G_RES);
  if (flags_live) {
    TrFlags(b, kTrAluFlags[o->aop], o->w == 64 ? 63 : 31);
  } else {
    g_stats.flag_elided++;
  }
  TrLocal(b, G_RES), TrPut(b, o->dst);
}

static void TrMovReg(struct Buf *b, int dst, int src, int w) {
  TrGet(b, src);
  if (w == 32) I64Const(b, 0xffffffffLL), B1(b, 0x83);
  TrPut(b, dst);
}

static void TrMovImm(struct Buf *b, int dst, i64 imm, int w) {
  I64Const(b, w == 64 ? imm : imm & 0xffffffffLL);
  TrPut(b, dst);
}

// Whether a supported register-only instruction; fills in what TrEmit needs. Excludes 8/16-bit
// operands (66 prefix, byte opcodes), memory operands, segments, LOCK, REP, two-byte opcodes.
static bool TrClassify(u64 rde, struct TrInsn *o) {
  u32 op = Mopcode(rde);
  int low;
  if (Osz(rde) || Lock(rde) || Rep(rde) || Opmap(rde) || Sego(rde) || Mode(rde) != XED_MODE_LONG) return false;
  o->w = Rexw(rde) ? 64 : 32;
  o->regsrc = false;
  switch (op) {
    case 0x81:
    case 0x83:
      if (!IsModrmRegister(rde)) return false;
      switch (ModrmReg(rde)) {
        case 0: o->aop = TR_ADD; break;
        case 1: o->aop = TR_OR; break;
        case 4: o->aop = TR_AND; break;
        case 5: o->aop = TR_SUB; break;
        case 6: o->aop = TR_XOR; break;
        default: return false;
      }
      o->kind = TR_ALUI;
      o->dst = RexbRm(rde);
      return true;
    case 0xc7:
      if (!IsModrmRegister(rde) || ModrmReg(rde)) return false;
      o->kind = TR_MOVI;
      o->dst = RexbRm(rde);
      return true;
    case 0x89:
    case 0x8b:
      if (!IsModrmRegister(rde)) return false;
      o->kind = TR_MOV;
      if (op == 0x89) {
        o->dst = RexbRm(rde), o->src = RexrReg(rde);
      } else {
        o->dst = RexrReg(rde), o->src = RexbRm(rde);
      }
      return true;
    default:
      break;
  }
  if (op >= 0xb8 && op <= 0xbf) {  // mov r, imm (imm64 with REX.W)
    o->kind = TR_MOVI;
    o->dst = RexbSrm(rde);
    return true;
  }
  low = op & 7;  // ALU r/m, r (1) and r, r/m (3)
  if (low != 1 && low != 3) return false;
  switch (op & 0xf8) {
    case 0x00: o->aop = TR_ADD; break;
    case 0x08: o->aop = TR_OR; break;
    case 0x20: o->aop = TR_AND; break;
    case 0x28: o->aop = TR_SUB; break;
    case 0x30: o->aop = TR_XOR; break;
    default: return false;
  }
  if (!IsModrmRegister(rde)) return false;
  o->kind = TR_ALU;
  o->regsrc = true;
  if (low == 1) {
    o->dst = RexbRm(rde), o->src = RexrReg(rde);
  } else {
    o->dst = RexrReg(rde), o->src = RexbRm(rde);
  }
  return true;
}

// IR that may run before a span without disturbing the guest state
static bool TrHarmless(int op) {
  return op == kIrSet || op == kIrMov || op == kIrEnter;
}

// Whether the span begun at g_ir[i] is one supported instruction, with its end found; sets *end.
// A span that is unterminated, or that holds a branch, stash, return, trap or another span, is not.
static bool TrSpanOk(const struct Ir *ir, long n, long i, long *end, struct TrInsn *o) {
  long j;
  for (j = i + 1; j < n; ++j) {
    switch (g_ir[j].op) {
      case kIrGuestEnd:
        *end = j;
        return TrClassify(ir->x, o);
      case kIrGuestBegin:
      case kIrStash:
      case kIrSkipZ:
      case kIrSkipNz:
      case kIrSkipCmp:
      case kIrJump:
      case kIrJumpLazy:
      case kIrRet:
      case kIrTrap:
      case kIrEnter:
        return false;
      default:
        break;
    }
  }
  return false;
}

// Whether the arithmetic flags defined by the ALU span ending at g_ir[end] are overwritten before anything
// can observe them: a linear lookahead that passes only kIrSet/kIrMov, harmless metadata and supported
// MOVs, and finds a supported ALU (which defines every arithmetic flag and reads none). Any other op,
// an unsupported or unterminated span, or the end of the body means the flags are live.
static bool TrFlagsOverwritten(long n, long end) {
  long j = end + 1;
  while (j < n) {
    const struct Ir *ir = g_ir + j;
    struct TrInsn o;
    long e;
    switch (ir->op) {
      case kIrSet:
      case kIrMov:
      case kIrGuestEnd:
        ++j;
        continue;
      case kIrGuestBegin:
        if (!TrSpanOk(ir, n, j, &e, &o)) return false;
        if (o.kind == TR_ALU || o.kind == TR_ALUI) return true;
        if (o.kind != TR_MOV && o.kind != TR_MOVI) return false;
        j = e + 1;
        continue;
      default:
        return false;
    }
  }
  return false;
}

static void TrEmit(struct Buf *b, const struct TrInsn *o, u64 uimm, bool flags_live) {
  switch (o->kind) {
    case TR_MOV:
      TrMovReg(b, o->dst, o->src, o->w);
      break;
    case TR_MOVI:
      TrMovImm(b, o->dst, (i64)uimm, o->w);
      break;
    case TR_ALU:
      TrAlu(b, o, 0, flags_live);
      break;
    case TR_ALUI:
      TrAlu(b, o, (i64)uimm, flags_live);
      break;
  }
}
