# OpenSSL: the openssl program, and static libssl/libcrypto with headers. Sourced by scripts/build-packages.sh.
source "$REPO/packages/openssl.inc"
NAME=openssl
VERSION=$OPENSSL_VERSION
DEPS=ca-certificates
DESC="OpenSSL TLS toolkit: the openssl program, and static libssl/libcrypto with headers"

build() {
	build_openssl "$PWD/src" || return 1
	make -C src install_sw install_ssldirs DESTDIR="$DEST" >install.log 2>&1 || { tail -20 install.log; return 1; }
	rm -rf "$DEST/usr/lib/pkgconfig" "$DEST/usr/bin/c_rehash" "$DEST/etc/ssl/misc" "$DEST"/etc/ssl/*.dist
	"$WORK/bin/strip" "$DEST/usr/bin/openssl" 2>/dev/null || true
}
