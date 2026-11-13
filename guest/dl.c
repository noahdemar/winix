/* dlopen() and dlsym() for guest programs.
 *
 * A shared object is a wasm module of the same position-independent form as a program (wasm-ld -shared; see
 * cc_link_so in scripts/build-packages.sh). This file reads it, allocates its data, and has the host link it
 * into the calling process: src/dylink.js binds its imports to the program's exports and gives it a part of the
 * process's function table. A program that wants dynamic loading links this file in (packages/python.sh does); the
 * libc's own dlopen is a stub ("Dynamic loading not supported"), built to be replaced, and it stays the entry point
 * for dlsym, dlclose and dlerror, which call the hooks defined here.
 *
 * What the objects can use is what the program exports, so a program meant to host them should export its whole
 * libc (-Wl,--whole-archive -lc), not just the parts it happens to call.
 *
 * Limits: nothing is ever unloaded (dlclose succeeds and does nothing); RTLD_LAZY binds at once, like RTLD_NOW;
 * RTLD_NEXT finds nothing; a thread-local variable in a shared object is usable only by the thread that loaded it;
 * a thread that already exists when an object is loaded cannot call into that object; no locking. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* The host side, in the runtime's linux-worker.js (patches/runtime/0008). Each returns -1 on failure. */
int __winix_dl_info(const void *bytes, size_t length, uint32_t out[4]); /* memory size, alignment, table size, needed */
int __winix_dl_needed(const void *bytes, size_t length, int index, char *name, size_t capacity);
int __winix_dl_open(const void *bytes, size_t length, void *base, int global, const int *deps, int deps_count);
int __winix_dl_sym(int handle, const char *name, void **out);
int __winix_dl_error(char *message, size_t capacity);

/* The libc's dlerror() state (src/ldso/dlerror.c). */
void __dl_seterr(const char *fmt, ...);

struct dso {
	struct dso *next;
	dev_t dev;
	ino_t ino;
	int handle; /* the host's handle; 0 is the program and everything opened RTLD_GLOBAL */
};

static struct dso program;
static struct dso *loaded;

static void host_error(const char *path)
{
	char why[256];
	__winix_dl_error(why, sizeof why);
	__dl_seterr("Error loading shared library %s: %s", path, why);
}

static struct dso *load(const char *path, int mode);

/* Finds a library by name the way ld.so does: beside the object that needs it, in LD_LIBRARY_PATH, then the
 * system directories. */
static struct dso *load_named(const char *name, const char *origin, int mode)
{
	char path[PATH_MAX];
	const char *env = getenv("LD_LIBRARY_PATH");
	const char *lists[] = { origin, env, "/usr/local/lib:/usr/lib:/lib" };

	if (strchr(name, '/'))
		return load(name, mode);
	for (size_t i = 0; i < sizeof lists / sizeof *lists; i++) {
		for (const char *dir = lists[i]; dir && *dir;) {
			size_t n = strcspn(dir, ":");
			if (n && snprintf(path, sizeof path, "%.*s/%s", (int)n, dir, name) < (int)sizeof path
			    && access(path, R_OK) == 0)
				return load(path, mode);
			dir += n + (dir[n] == ':');
		}
	}
	__dl_seterr("Error loading shared library %s: No such file or directory", name);
	return 0;
}

static struct dso *load(const char *path, int mode)
{
	struct stat st;
	struct dso *d = 0;
	unsigned char *bytes = 0;
	void *base = 0;
	int *deps = 0;
	uint32_t info[4];
	char origin[PATH_MAX], name[NAME_MAX + 1];
	size_t size, got = 0;
	int handle;

	int fd = open(path, O_RDONLY | O_CLOEXEC);
	if (fd < 0 || fstat(fd, &st) < 0 || !S_ISREG(st.st_mode)) {
		__dl_seterr("Error loading shared library %s: %s", path, strerror(fd < 0 ? errno : ENOEXEC));
		if (fd >= 0)
			close(fd);
		return 0;
	}
	/* One copy of each file, however it was named. */
	for (d = loaded; d; d = d->next) {
		if (d->dev == st.st_dev && d->ino == st.st_ino) {
			close(fd);
			return d;
		}
	}

	size = st.st_size;
	bytes = malloc(size ? size : 1);
	while (bytes && got < size) {
		ssize_t n = read(fd, bytes + got, size - got);
		if (n < 0 && errno == EINTR)
			continue;
		if (n <= 0)
			break;
		got += n;
	}
	close(fd);
	if (!bytes || got != size) {
		__dl_seterr("Error loading shared library %s: %s", path, bytes ? "short read" : "out of memory");
		goto fail;
	}
	if (__winix_dl_info(bytes, size, info) < 0) {
		host_error(path);
		goto fail;
	}

	/* The libraries it needs come first: its imports are bound when it is linked. */
	if (info[3]) {
		const char *slash = strrchr(path, '/');
		if (!slash)
			strcpy(origin, ".");
		else
			snprintf(origin, sizeof origin, "%.*s", slash == path ? 1 : (int)(slash - path), path);
		deps = malloc(info[3] * sizeof *deps);
		if (!deps) {
			__dl_seterr("Error loading shared library %s: out of memory", path);
			goto fail;
		}
		for (uint32_t i = 0; i < info[3]; i++) {
			struct dso *dep;
			if (__winix_dl_needed(bytes, size, i, name, sizeof name) < 0) {
				host_error(path);
				goto fail;
			}
			dep = load_named(name, origin, mode);
			if (!dep)
				goto fail; /* its error stands */
			deps[i] = dep->handle;
		}
	}

	/* Its data and bss, zeroed; the object copies its initialised data in when it is instantiated. */
	if (info[0]) {
		if (posix_memalign(&base, info[1] > 16 ? info[1] : 16, info[0])) {
			__dl_seterr("Error loading shared library %s: out of memory", path);
			goto fail;
		}
		memset(base, 0, info[0]);
	}
	d = malloc(sizeof *d);
	if (!d) {
		__dl_seterr("Error loading shared library %s: out of memory", path);
		goto fail;
	}
	handle = __winix_dl_open(bytes, size, base, !!(mode & RTLD_GLOBAL), deps, info[3]);
	if (handle < 0) {
		host_error(path);
		goto fail;
	}
	free(bytes); /* the host compiled its own copy */
	free(deps);
	d->dev = st.st_dev;
	d->ino = st.st_ino;
	d->handle = handle;
	d->next = loaded;
	loaded = d;
	return d;

fail:
	free(bytes);
	free(deps);
	free(base);
	free(d);
	return 0;
}

void *dlopen(const char *file, int mode)
{
	if (!file)
		return &program;
	return load_named(file, 0, mode);
}

int __dl_invalid_handle(void *h)
{
	if (h == &program)
		return 0;
	for (struct dso *d = loaded; d; d = d->next)
		if (h == d)
			return 0;
	__dl_seterr("Invalid library handle %p", h);
	return 1;
}

void *__dlsym(void *restrict p, const char *restrict s, void *restrict ra);

/* What <dlfcn.h> renames dlsym to on a 32-bit target, once a header with the type definitions has been included.
 * Other architectures have it in assembly, to pass the caller's address on; the libc's wasm port has none. */
void *__dlsym_time64(void *restrict p, const char *restrict s)
{
	return __dlsym(p, s, 0);
}

void *__dlsym(void *restrict p, const char *restrict s, void *restrict ra)
{
	void *address;
	int handle = 0;

	(void)ra;
	if (p == RTLD_NEXT) {
		__dl_seterr("Symbol not found: %s", s);
		return 0;
	}
	if (p != RTLD_DEFAULT) {
		if (__dl_invalid_handle(p))
			return 0;
		handle = ((struct dso *)p)->handle;
	}
	if (__winix_dl_sym(handle, s, &address) < 0) {
		__dl_seterr("Symbol not found: %s", s);
		return 0;
	}
	return address;
}
