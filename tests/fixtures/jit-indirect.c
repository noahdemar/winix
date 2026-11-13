// Driver for the indirect call/jmp loops in jit-indirect.S. Expected output is in tests/jit-indirect.mjs.
// Freestanding (no libc): blink does not run glibc static binaries, and this keeps the fixture small.

extern long loop_disp(void *), loop_jmp(void *), loop_rip(void), loop_sib(void *), loop_alt(void *),
    loop_cross(void *), loop_sp(void), loop_addr32(void *), loop_fs(void), loop_stackcross(void *);
extern char tab[], jtab[], alttab[], crosspage[];

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

static void put_result(const char *name, long v) {
  char buf[32];
  int i = 31;
  buf[i] = '\n';
  do {
    buf[--i] = '0' + v % 10;
    v /= 10;
  } while (v);
  put(name);
  put(" ");
  sys3(1, 1, (long)(buf + i), 32 - i);
}

void driver(void) {
  put_result("disp", loop_disp(tab));
  put_result("jmp", loop_jmp(jtab));
  put_result("rip", loop_rip());
  put_result("sib", loop_sib(tab));
  put_result("alt", loop_alt(alttab));
  put_result("cross", loop_cross(crosspage + 4092));
  put_result("sp", loop_sp());
  put_result("addr32", loop_addr32(tab));
  put_result("fs", loop_fs());
  put_result("stackcross", loop_stackcross(tab));
  sys3(60, 0, 0, 0);  // exit
}
