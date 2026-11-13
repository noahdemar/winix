/* In-guest test of dlopen() (guest/dl.c, src/dylink.js): prints "ok <name>" or "FAIL <name>" for each check and
 * exits non-zero if any failed. Built by packages/dltest.sh, run by tests/dlopen.mjs.
 * Usage: dltest [library dir [threads]] | dltest threads-only */
#define _GNU_SOURCE
#include <stdio.h> /* before dlfcn.h, as in most programs: dlsym is then the libc's renamed __dlsym_time64 */
#include <dlfcn.h>
#include <errno.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

int host_value = 41;                    /* libone reads this, through its GOT */
int host_twice(int x) { return 2 * x; } /* libone calls this, and takes its address */

static int failures;

static void check(const char *name, int ok)
{
	printf("%s %s\n", ok ? "ok" : "FAIL", name);
	failures += !ok;
}

/* Runs in a clone() child, whose Worker has its own function table: the library must be there too. */
static int (*child_fn)(int);
static int child(void *arg)
{
	_exit(child_fn(*(int *)arg) == 49 ? 7 : 1);
	return 0;
}

/* A thread is a clone() too, with its own stack and thread pointer. */
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static int shared_total;
static void *thread_main(void *arg)
{
	int (*square)(int) = arg;
	for (int i = 0; i < 1000; i++) {
		pthread_mutex_lock(&lock);
		shared_total += square(2);
		pthread_mutex_unlock(&lock);
	}
	return (void *)(long)square(6);
}

#define SYM(type, handle, name) ((type)dlsym(handle, name))

static int local_square(int x) { return x * x; }

/* Two threads, each calling square 1000 times under a mutex. */
static void check_threads(int (*square)(int))
{
	pthread_t t[2];
	void *ret[2] = { 0, 0 };
	int err = pthread_create(&t[0], NULL, thread_main, square) || pthread_create(&t[1], NULL, thread_main, square);
	check("threads start", !err);
	check("threads run and are joined", !err && !pthread_join(t[0], &ret[0]) && !pthread_join(t[1], &ret[1])
		&& (long)ret[0] == 36 && (long)ret[1] == 36);
	check("threads share memory under a mutex", shared_total == 8000);
}

int main(int argc, char **argv)
{
	const char *dir = argc > 1 ? argv[1] : "/usr/lib/dltest";
	char path[512];
	const char *why;

	if (argc > 1 && !strcmp(argv[1], "threads-only")) { /* no library loaded: threads by themselves */
		check_threads(local_square);
		printf("%s\n", failures ? "FAILED" : "PASSED");
		return failures != 0;
	}

	snprintf(path, sizeof path, "%s/libone.so", dir);
	void *one = dlopen(path, RTLD_NOW);
	if (!one) {
		printf("FAIL dlopen %s: %s\n", path, dlerror());
		return 1;
	}
	check("dlopen", 1);
	check("same file, same handle", dlopen(path, RTLD_NOW) == one);
	check("constructor ran after relocations", SYM(int (*)(void), one, "one_constructed")() == 42);
	check("call a function", SYM(int (*)(int), one, "one_square")(7) == 49);
	check("read a data symbol", *SYM(int *, one, "one_data") == 5);
	check("library calls the program", SYM(int (*)(int), one, "one_calls_host")(4) == 8 + 41);
	check("one function, one pointer", SYM(int (*(*)(void))(int), one, "one_host_pointer")() == host_twice);

	int v[] = { 3, 9, 1, 7 };
	SYM(void (*)(int *, int), one, "one_sort")(v, 4);
	check("libc calls back into the library (qsort)", v[0] == 9 && v[1] == 7 && v[2] == 3 && v[3] == 1);

	char *s = SYM(char *(*)(int), one, "one_format")(5);
	check("shared heap and stdio", s && !strcmp(s, "<5>"));
	free(s);
	check("shared errno", SYM(int (*)(void), one, "one_errno")() == ENOENT);
	check("libm the program never calls", SYM(double (*)(double), one, "one_math")(16.0) == 8.0);
	check("setjmp/longjmp inside the library", SYM(int (*)(void), one, "one_jump")() == 3);

	snprintf(path, sizeof path, "%s/libtwo.so", dir);
	void *two = dlopen(path, RTLD_NOW);
	check("a needed library is found beside it", two && SYM(int (*)(int), two, "two_sum")(3) == 9 + 5);

	unsetenv("LD_LIBRARY_PATH");
	check("a bare name is not found without a path", !dlopen("libone.so", RTLD_NOW) && dlerror());
	setenv("LD_LIBRARY_PATH", dir, 1);
	check("LD_LIBRARY_PATH", dlopen("libone.so", RTLD_NOW) == one);

	snprintf(path, sizeof path, "%s/libbad.so", dir);
	check("undefined symbol fails the load", !dlopen(path, RTLD_NOW) && (why = dlerror()) && strstr(why, "no_such_function"));
	FILE *f = fopen("/tmp/dltest-not-a-library", "w");
	if (f) {
		fputs("just text\n", f);
		fclose(f);
	}
	check("not a shared object", !dlopen("/tmp/dltest-not-a-library", RTLD_NOW) && (why = dlerror()) && strstr(why, "not a shared object"));
	check("unknown symbol", !dlsym(one, "nope") && dlerror());
	check("dlerror clears", !dlerror());
	check("RTLD_DEFAULT finds the program", dlsym(RTLD_DEFAULT, "host_value") == &host_value);
	check("handles are private by default", !dlsym(RTLD_DEFAULT, "one_data"));
	check("dlclose", dlclose(one) == 0 && dlclose(&failures) != 0);

	int arg = 7, status = 0;
	child_fn = SYM(int (*)(int), one, "one_square");
	pid_t pid = clone(child, NULL, CLONE_VM | CLONE_VFORK | SIGCHLD, &arg);
	check("clone() child calls into the library", pid > 0 && waitpid(pid, &status, 0) == pid
		&& WIFEXITED(status) && WEXITSTATUS(status) == 7);

	if (argc > 2 && !strcmp(argv[2], "threads")) /* threads created after dlopen, calling into the library */
		check_threads(child_fn);

	printf("%s\n", failures ? "FAILED" : "PASSED");
	return failures != 0;
}
