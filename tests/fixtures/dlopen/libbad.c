/* Cannot be loaded: no_such_function is defined nowhere. */
int no_such_function(int);
__attribute__((visibility("default"))) int bad(void) { return no_such_function(1); }
