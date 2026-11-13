/* Cannot load: nowhere() is defined nowhere. Its table entry must not move later objects. */
int nowhere(int);
static int c_static(int x) { return x; }
int (*c_fp)(int) = c_static;
int c_call(void) { return nowhere(1); }
