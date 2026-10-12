# CPython 3.12 (python3) cross-built for winix's wasm32 musl guest. Sourced by scripts/build-packages.sh.
# EXPERIMENTAL: built only when named. Needs WINIX_HOST_PYTHON: a native python3.12 on the build host (the cross
# configure requires the same version as the source; the system python3 on Ubuntu 22.04 is 3.10).
EXPERIMENTAL=1
NAME=python
VERSION=3.12.8
DEPS=-
DESC="Python 3.12 interpreter and standard library (no threads, no dynamic extension modules)"
URL=https://www.python.org/ftp/python/$VERSION/Python-$VERSION.tgz
SHA256=5978435c479a376648cb02854df3b892ace9ed7d32b1fead652712bee9d03a45
ZLIB_URL=https://github.com/madler/zlib/releases/download/v1.3.1/zlib-1.3.1.tar.gz
ZLIB_SHA256=9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23

build() {
	: "${WINIX_HOST_PYTHON:?set WINIX_HOST_PYTHON to a python3.12 binary on the build host}"
	fetch "$URL" "$SHA256" src.tgz
	tar xzf src.tgz --strip-components=1

	# zlib, built here as a static library: CPython's zlib module links it.
	fetch "$ZLIB_URL" "$ZLIB_SHA256" zlib.tgz
	mkdir zlibsrc && tar xzf zlib.tgz -C zlibsrc --strip-components=1
	(cd zlibsrc && CC="$WASM_CC" AR="$WORK/bin/ar" RANLIB="$WORK/bin/ranlib" ./configure --static --prefix=/usr >/dev/null && make -j"$(nproc)" libz.a >/dev/null)
	ZLIB="$PWD/zlibsrc"

	# The guest toolchain cannot run test programs, so facts configure would probe are given here. Any function
	# musl lacks that configure still finds (the guest link is -shared, which accepts undefined symbols) must be listed.
	export ac_cv_file__dev_ptmx=no ac_cv_file__dev_ptc=no ac_cv_func_dlopen=no ac_cv_lib_dl_dlopen=no \
		ac_cv_pthread_is_default=yes ac_cv_working_tzset=yes ac_cv_pthread=no ac_cv_func_sigaltstack=no \
		ac_cv_func_sem_clockwait=no ac_cv_func_close_range=no ac_cv_func_fdwalk=no \
		ac_cv_func_chflags=no ac_cv_func_lchflags=no ac_cv_func_rtpSpawn=no \
		ac_cv_func_fork1=no ac_cv_func_plock=no ac_cv_func_getwd=no ac_cv_func__getpty=no ac_cv_func_pthread_init=no \
		ac_cv_func_explicit_memset=no ac_cv_func_uuid_generate_time_safe=no
	CC="$WASM_CC" CPPFLAGS="-I$ZLIB" LDFLAGS="-L$ZLIB" ./configure \
		--host=wasm32-linux-musl --build=x86_64-pc-linux-gnu --with-build-python="$WINIX_HOST_PYTHON" \
		--prefix=/usr --disable-shared --without-pymalloc --without-ensurepip --disable-ipv6 \
		--without-doc-strings --without-threads >configure.log 2>&1 || { tail -40 configure.log; return 1; }

	# Modules whose headers or libraries winix does not package yet. _ctypes needs libffi; _uuid needs libuuid.
	printf '%s\n' '*disabled*' '_lzma' 'readline' 'nis' '_ctypes' '_uuid' > Modules/Setup.local

	make -j"$(nproc)" python

	mkdir -p "$DEST/usr/bin" "$DEST/usr/lib/python3.12"
	cp python "$DEST/usr/bin/python3"
	"$WORK/bin/strip" "$DEST/usr/bin/python3" 2>/dev/null || true
	# The standard library without test suites, tkinter, IDLE and the bundled pip wheel (ensurepip is disabled).
	cp -r Lib/. "$DEST/usr/lib/python3.12/"
	rm -rf "$DEST"/usr/lib/python3.12/{test,idlelib,tkinter,turtledemo,ensurepip,lib2to3}
	find "$DEST/usr/lib/python3.12" -name __pycache__ -prune -exec rm -rf {} +
}
