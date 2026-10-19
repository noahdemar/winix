# CPython 3.12 (python3) cross-built for winix's wasm32 musl guest. Sourced by scripts/build-packages.sh.
# The cross build needs a native CPython 3.12 on the build host, which must match the source version. If
# WINIX_HOST_PYTHON is unset, the recipe builds one from the same source with the host compiler.
source "$REPO/packages/openssl.inc"
NAME=python
VERSION=3.12.8
DEPS=ca-certificates
DESC="Python 3.12 interpreter and standard library (sqlite3, ssl; no threads, no dynamic extension modules)"
URL=https://www.python.org/ftp/python/$VERSION/Python-$VERSION.tgz
SHA256=5978435c479a376648cb02854df3b892ace9ed7d32b1fead652712bee9d03a45
ZLIB_URL=https://github.com/madler/zlib/releases/download/v1.3.1/zlib-1.3.1.tar.gz
ZLIB_SHA256=9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23
SQLITE_URL=https://www.sqlite.org/2024/sqlite-amalgamation-3470200.zip
SQLITE_SHA256=aa73d8748095808471deaa8e6f34aa700e37f2f787f4425744f53fdd15a89c40

build() {
	fetch "$URL" "$SHA256" src.tgz
	tar xzf src.tgz --strip-components=1
	# subprocess: the guest has no fork()/vfork(), so children start through clone() (see the patch).
	patch -p1 < "$REPO/packages/python-subprocess-clone.patch" >/dev/null || return 1
	# The C recursion limit WASI builds use (500, not 10000): each level takes a few KiB of the Wasm stack, and with
	# no guard page an overflow silently corrupts the memory below it (other processes', or the kernel's) instead of
	# raising RecursionError.
	sed -i 's/#  if defined(__wasi__)$/#  if defined(__wasi__) || defined(__wasm__)/' Include/cpython/pystate.h || return 1
	[ "$(grep -c 'defined(__wasi__) || defined(__wasm__)' Include/cpython/pystate.h)" = 2 ] || return 1

	# Host CPython for the cross build. Built in a clean environment so the guest cc wrapper and CC do not leak in.
	if [ -n "${WINIX_HOST_PYTHON:-}" ]; then
		HOSTPY="$WINIX_HOST_PYTHON"
	else
		rm -rf "$PWD/hostsrc" && mkdir "$PWD/hostsrc" && tar xzf src.tgz -C "$PWD/hostsrc" --strip-components=1
		(cd "$PWD/hostsrc" && env -i PATH=/usr/bin:/bin HOME="$HOME" ./configure --without-ensurepip >configure.log 2>&1 \
			&& env -i PATH=/usr/bin:/bin HOME="$HOME" make -j"$(nproc)" python >make.log 2>&1) \
			|| { tail -20 "$PWD/hostsrc/configure.log" "$PWD/hostsrc/make.log"; return 1; }
		HOSTPY="$PWD/hostsrc/python"
	fi

	# zlib, built here as a static library: CPython's zlib module links it.
	fetch "$ZLIB_URL" "$ZLIB_SHA256" zlib.tgz
	mkdir zlibsrc && tar xzf zlib.tgz -C zlibsrc --strip-components=1
	(cd zlibsrc && CC="$WASM_CC" AR="$WORK/bin/ar" RANLIB="$WORK/bin/ranlib" ./configure --static --prefix=/usr >/dev/null && make -j"$(nproc)" libz.a >/dev/null)
	ZLIB="$PWD/zlibsrc"

	# sqlite3 module: the same amalgamation and flags as packages/sqlite.sh, as a static library.
	fetch "$SQLITE_URL" "$SQLITE_SHA256" sqlite.zip
	python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(".")' sqlite.zip || return 1
	SQLITE="$PWD/$(ls -d sqlite-amalgamation-*)" || return 1
	"$WASM_CC" -DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_LOAD_EXTENSION -DSQLITE_MAX_MMAP_SIZE=0 -DSQLITE_DQS=0 \
		-DSQLITE_ENABLE_FTS5 -DSQLITE_ENABLE_MATH_FUNCTIONS -c "$SQLITE/sqlite3.c" -o "$SQLITE/sqlite3.o" || return 1
	"$WORK/bin/ar" rcs "$SQLITE/libsqlite3.a" "$SQLITE/sqlite3.o" || return 1

	# ssl and hashlib: OpenSSL as static libraries, installed into a staging prefix for configure to find.
	build_openssl "$PWD/opensslsrc" || return 1
	make -C opensslsrc install_dev DESTDIR="$PWD/ossl" >/dev/null || return 1
	OSSL="$PWD/ossl/usr"

	# The guest toolchain cannot run test programs, so facts configure would probe are given here. Any function
	# musl lacks that configure still finds (the guest link is -shared, which accepts undefined symbols) must be listed.
	export ac_cv_file__dev_ptmx=no ac_cv_file__dev_ptc=no ac_cv_func_dlopen=no ac_cv_lib_dl_dlopen=no \
		ac_cv_pthread_is_default=yes ac_cv_working_tzset=yes ac_cv_pthread=no ac_cv_func_sigaltstack=no \
		ac_cv_func_sem_clockwait=no ac_cv_func_close_range=no ac_cv_func_fdwalk=no \
		ac_cv_func_chflags=no ac_cv_func_lchflags=no ac_cv_func_rtpSpawn=no \
		ac_cv_func_fork1=no ac_cv_func_plock=no ac_cv_func_getwd=no ac_cv_func__getpty=no ac_cv_func_pthread_init=no \
		ac_cv_func_explicit_memset=no ac_cv_func_uuid_generate_time_safe=no
	CC="$WASM_CC" CPPFLAGS="-I$ZLIB -I$SQLITE" LDFLAGS="-L$ZLIB -L$SQLITE" ./configure \
		--host=wasm32-linux-musl --build=x86_64-pc-linux-gnu --with-build-python="$HOSTPY" \
		--prefix=/usr --disable-shared --without-pymalloc --without-ensurepip --disable-ipv6 \
		--without-doc-strings --without-threads --with-openssl="$OSSL" >configure.log 2>&1 		|| { tail -40 configure.log; return 1; }
	grep -q '^MODULE__SSL_STATE=yes' Makefile || { grep -i -A3 openssl configure.log | tail -20; return 1; }

	# Modules are listed explicitly: sqlite3 is built statically from the amalgamation; the others need libraries
	# winix does not package yet (_lzma: xz, readline, nis: rpcsvc headers, _ctypes: libffi, _uuid: libuuid).
	printf '%s\n' \
		'*static*' \
		"_sqlite3 _sqlite/blob.c _sqlite/connection.c _sqlite/cursor.c _sqlite/microprotocols.c _sqlite/module.c _sqlite/prepare_protocol.c _sqlite/row.c _sqlite/statement.c _sqlite/util.c -DSQLITE_OMIT_LOAD_EXTENSION -I$SQLITE -L$SQLITE -lsqlite3" \
		'*disabled*' '_lzma' 'readline' 'nis' '_ctypes' '_uuid' > Modules/Setup.local

	# -Bsymbolic binds references to symbols defined in this module directly. Without it, CPython's cross-object
	# references become 373 GOT.* imports, which winix's runtime does not supply, so the module fails to instantiate
	# (reported as "Illegal instruction"). Lua has none. The link stays the shared-object form the loader expects.
	rm -f python
	make -j"$(nproc)" LDFLAGS="-L$ZLIB -L$SQLITE -L$OSSL/lib -Wl,-Bsymbolic" python || return 1
	[ -x python ] || return 1
	# sysconfig's build-time variables (_sysconfigdata__linux_.py), which pip and setuptools read.
	make pybuilddir.txt >/dev/null || return 1

	mkdir -p "$DEST/usr/bin" "$DEST/usr/lib/python3.12/lib-dynload" # no extension modules: lib-dynload stays empty
	cp python "$DEST/usr/bin/python3" || return 1
	"$WORK/bin/strip" "$DEST/usr/bin/python3" 2>/dev/null || true
	# A 4 MiB stack (patches/kernel/0006) instead of the default 256 KiB, which compiling a module under nested
	# imports (pip importing tarfile) overflows. Appended after strip, which would drop the custom section.
	python3 - "$DEST/usr/bin/python3" $((4 << 20)) <<'PY' || return 1
import sys
def leb(n):
    out = bytearray()
    while True:
        b, n = n & 0x7F, n >> 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)
name = b"winix.stack_size"
body = leb(len(name)) + name + int(sys.argv[2]).to_bytes(4, "little")
with open(sys.argv[1], "ab") as f:
    f.write(b"\x00" + leb(len(body)) + body)
PY
	# The standard library without test suites, tkinter, IDLE and the bundled pip wheel (packages/pip.sh has pip).
	cp -r Lib/. "$DEST/usr/lib/python3.12/"
	rm -rf "$DEST"/usr/lib/python3.12/{test,idlelib,tkinter,turtledemo,ensurepip,lib2to3}
	cp "$(cat pybuilddir.txt)"/_sysconfigdata_*.py "$DEST/usr/lib/python3.12/" || return 1
	find "$DEST/usr/lib/python3.12" -name __pycache__ -prune -exec rm -rf {} +
}
