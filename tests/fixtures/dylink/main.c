/* Stand-in for a guest program in tests/dylink.mjs: position-independent, exports everything, no libc.
 * Linked -Bsymbolic like real programs, since the runtime gives a program no GOT imports. */
int main_counter = 7;

int main_add(int a, int b) { return a + b; }
int main_twice(int x) { return 2 * x; } /* its address is never taken here: not in the table until a library asks */

int (*main_fp)(int, int) = main_add; /* address taken: in the table from the start */
int (*main_get_fp(void))(int, int) { return main_fp; }

/* Calls through the function table, as C does with any function pointer. */
int main_call1(int (*f)(int), int x) { return f(x); }
int main_call0(int (*f)(void)) { return f(); }
int main_load(int *p) { return *p; }
