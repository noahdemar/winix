// Driver for the register-only semantic tier cases in jit-trace.S. Expected output: jit-trace.expected.
// Freestanding (no libc): blink does not run glibc static binaries.

extern long case_zext(unsigned long *), case_chain(unsigned long *), case_wrap(unsigned long *),
    case_ovf(unsigned long *), case_borrow(unsigned long *), case_deadlive(unsigned long *),
    case_carry(unsigned long *), case_mem(unsigned long *), case_call(unsigned long *),
    case_branch(unsigned long *), case_nimm(unsigned long *), case_flagbarrier(unsigned long *);

static long sys3(long n, long a, long b, long c) {
  long r;
  __asm__ volatile("syscall" : "=a"(r) : "a"(n), "D"(a), "S"(b), "d"(c) : "rcx", "r11", "memory");
  return r;
}

static void put(const char *s) {
  long n = 0;
  while (s[n]) n++;
  sys3(1, 1, (long)s, n);
}

static void put_hex(unsigned long v) {
  char buf[20];
  int i = 19;
  buf[i] = '\0';
  do {
    buf[--i] = "0123456789abcdef"[v & 15];
    v >>= 4;
  } while (v);
  buf[--i] = 'x';
  buf[--i] = '0';
  put(buf + i);
}

static void line(const char *name, unsigned long v, unsigned long flags, int with_flags) {
  put(name);
  put(" ");
  put_hex(v);
  if (with_flags) {
    put(" ");
    put_hex(flags & 0x8d5);
  }
  put("\n");
}

void driver(void) {
  unsigned long fl = 0;
  unsigned long v;
  v = case_zext(&fl);
  line("zext", v, 0, 0);
  v = case_chain(&fl);
  line("chain", v, 0, 0);
  v = case_wrap(&fl);
  line("wrap", v, fl, 1);
  v = case_ovf(&fl);
  line("ovf", v, fl, 1);
  v = case_borrow(&fl);
  line("borrow", v, fl, 1);
  v = case_deadlive(&fl);
  line("deadlive", v, fl, 1);
  v = case_carry(&fl);
  line("carry", v, 0, 0);
  v = case_mem(&fl);
  line("mem", v, 0, 0);
  v = case_call(&fl);
  line("call", v, 0, 0);
  v = case_branch(&fl);
  line("branch", v, 0, 0);
  v = case_nimm(&fl);
  line("nimm", v, 0, 0);
  v = case_flagbarrier(&fl);
  line("flagbarrier", v, fl, 1);
  sys3(60, 0, 0, 0);  // exit
}
