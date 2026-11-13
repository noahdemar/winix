# jq command-line JSON processor. Sourced by scripts/build-packages.sh.
NAME=jq
VERSION=1.7.1
DEPS=-
DESC="jq, a command-line JSON processor"
URL=https://github.com/jqlang/jq/releases/download/jq-$VERSION/jq-$VERSION.tar.gz
SHA256=478c9ca129fd2e3443fe27314b455e211e0d8c60bc8ff7df703873deeee580c2

build() {
	fetch "$URL" "$SHA256" src.tar.gz
	tar xzf src.tar.gz --strip-components=1
	# Oniguruma is bundled (modules/oniguruma), so the only external dependency is libc.
	# musl lacks these glibc-only libm functions; configure would otherwise detect them and jq would fail to compile.
	CC="$WASM_CC" ac_cv_func_gamma=no ac_cv_func_drem=no ac_cv_func_significand=no ac_cv_func_pow10=no \
		ac_cv_func_exp10=no ac_cv_func_gamma_r=no ./configure --host=wasm32-linux-musl --disable-docs \
		--disable-valgrind --disable-maintainer-mode --with-oniguruma=builtin --disable-shared --enable-static
	# configure defines HAVE_GAMMA from the host check; src/libm.h then calls gamma(), which musl does not provide.
	sed -i 's/-DHAVE_GAMMA=1//g' Makefile
	make -j"$(nproc)"
	mkdir -p "$DEST/usr/bin"
	cp jq "$DEST/usr/bin/jq"
}
