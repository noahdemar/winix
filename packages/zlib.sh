# zlib compression library (libz) with headers. Sourced by scripts/build-packages.sh.
NAME=zlib
VERSION=1.3.1
DEPS=-
DESC="zlib compression library, with headers"
URL=https://github.com/madler/zlib/releases/download/v$VERSION/zlib-$VERSION.tar.gz
SHA256=9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23

build() {
	fetch "$URL" "$SHA256" src.tar.gz
	tar xzf src.tar.gz --strip-components=1
	# Static only: guest programs have no dlopen, and this is the library CPython and git link against.
	CC="$WASM_CC" AR="$WORK/bin/ar" RANLIB="$WORK/bin/ranlib" ./configure --static --prefix=/usr
	make -j"$(nproc)" libz.a
	mkdir -p "$DEST/usr/lib" "$DEST/usr/include"
	cp libz.a "$DEST/usr/lib/"
	cp zlib.h zconf.h "$DEST/usr/include/"
}
