/* Shared object for dltest.c. It has no libc of its own: malloc, qsort, stdio, errno and libm are the program's. */
#include <errno.h>
#include <math.h>
#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>

#define EXPORT __attribute__((visibility("default")))

extern int host_value;
int host_twice(int);

EXPORT int one_data = 5;

static int constructed;
__attribute__((constructor)) static void init(void) { constructed = host_value + 1; }
EXPORT int one_constructed(void) { return constructed; }

EXPORT int one_square(int x) { return x * x; }
EXPORT int one_calls_host(int x) { return host_twice(x) + host_value; }
EXPORT int (*one_host_pointer(void))(int) { return host_twice; }

static int descending(const void *a, const void *b) { return *(const int *)b - *(const int *)a; }
EXPORT void one_sort(int *v, int n) { qsort(v, n, sizeof *v, descending); }

EXPORT char *one_format(int x)
{
	char *s = malloc(32);
	if (s)
		snprintf(s, 32, "<%d>", x);
	return s;
}

EXPORT int one_errno(void)
{
	errno = 0;
	if (fopen("/nonexistent/file", "r"))
		return -1;
	return errno;
}

EXPORT double one_math(double x) { return ldexp(x, -1) + fmod(x, 16.0); }

static jmp_buf env;
static void jump(int v) { longjmp(env, v); }
EXPORT int one_jump(void)
{
	volatile int r = setjmp(env);
	if (!r)
		jump(3);
	return r;
}
