# Blink: x86-64 Linux user-mode emulator (runs x86-64 Linux programs inside winix). Sourced by build-packages.sh.
NAME=blink
VERSION=1.1.0
DEPS=-
DESC="x86-64 Linux user-mode emulator (blink), used by apt for packages without a wasm build"
URL=https://github.com/jart/blink/archive/refs/tags/$VERSION.tar.gz
SHA256=2649793e1ebf12027f5e240a773f452434cefd9494744a858cd8bff8792dba68

build() {
	fetch "$URL" "$SHA256" src.tar.gz
	tar xzf src.tar.gz --strip-components=1
	patch -p1 < "$REPO/packages/blink-wasm.patch"
	# The guest has no threads, JIT or fixed-address mmap; fork is a snapshot (see blink-wasm.patch).
	CC=cc ./configure --disable-jit --disable-threads --disable-sockets
	# configure probes by running test programs, which cannot run when cross-compiling, so it turns off features
	# the guest libc and kernel do have. Turn them back on (not threads, sockets, shared or anonymous mappings).
	# FORK is the snapshot fork from blink-wasm.patch.
	for f in FORK DEV_URANDOM DUP3 EPOLL_PWAIT1 FDATASYNC FEXECVE GETDOMAINNAME GETENTROPY GETRANDOM \
		MEMCCPY MKFIFOAT PIPE2 PREADV REALPATH SCHED_GETAFFINITY SCHED_H SCHED_YIELD SEEKDIR SETGROUPS SETRESUID \
		SETREUID STRCHRNUL STRUCT_TIMEZONE SYNC SYSINFO SYS_GETENTROPY SYS_GETRANDOM SYS_MOUNT_H VASPRINTF WAIT4; do
		sed -i "s|^// #define HAVE_$f\$|#define HAVE_$f|" config.h
	done
	# clang 18 makes int-conversion an error; blink's fallback atomics (no stdatomic.h here) trip it.
	# LLVM only lowers setjmp/longjmp to wasm exceptions, so blink's sigsetjmp/siglongjmp (its CPU fault path) map
	# onto them; the signal mask is not saved, which blink does not rely on.
	make -j"$(nproc)" CFLAGS="-O3 -DNDEBUG -Wno-int-conversion -D'sigsetjmp(b,s)=setjmp(b)' -Dsiglongjmp=longjmp" o//blink/blink
	mkdir -p "$DEST/usr/bin"
	cp o//blink/blink "$DEST/usr/bin/blink"
}
