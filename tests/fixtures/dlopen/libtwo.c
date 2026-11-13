/* Needs libone.so (named in its dylink.0 section), found in the directory it was loaded from. */
#define EXPORT __attribute__((visibility("default")))
int one_square(int);
extern int one_data;
EXPORT int two_sum(int x) { return one_square(x) + one_data; }
