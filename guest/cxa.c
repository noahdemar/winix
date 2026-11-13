/* C++ `throw`, for code linked with the guest's C++ library (scripts/build-libcxx.sh), which is built without
 * exception support: the toolchain's default for wasm compiles a throw into these calls and drops every catch, so
 * a thrown exception could never be caught. It ends the program with a message instead. Linked into C++ programs
 * and shared objects by build-packages.sh's c++ wrapper. */
#include <stdlib.h>
#include <unistd.h>

#define HIDDEN __attribute__((visibility("hidden")))

HIDDEN void *__cxa_allocate_exception(size_t size)
{
	void *p = malloc(size ? size : 1);
	if (!p)
		abort();
	return p;
}

HIDDEN void __cxa_throw(void *exception, void *type, void (*destructor)(void *))
{
	static const char message[] = "terminating: a C++ exception was thrown (not supported in this build)\n";
	(void)exception;
	(void)type;
	(void)destructor;
	if (write(2, message, sizeof message - 1) < 0) { /* nothing more to do */ }
	abort();
}
