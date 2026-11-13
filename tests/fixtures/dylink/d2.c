/* d1 and d2 define the same names: each sees its own unless the other was opened RTLD_GLOBAL first. */
int shared_name = 2;
int *d_get(void) { return &shared_name; }
