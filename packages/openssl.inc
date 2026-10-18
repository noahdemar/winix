# OpenSSL source and its static guest build, shared by packages/openssl.sh and packages/python.sh (not a recipe:
# build-packages.sh only builds packages/*.sh).
OPENSSL_VERSION=3.5.9
OPENSSL_URL=https://github.com/openssl/openssl/releases/download/openssl-$OPENSSL_VERSION/openssl-$OPENSSL_VERSION.tar.gz
OPENSSL_SHA256=603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a

# build_openssl DIR: unpacks and builds OpenSSL in DIR (static libssl.a/libcrypto.a, the openssl program), with its
# default certificate file at /etc/ssl/cert.pem (packages/ca-certificates.sh). Install with `make -C DIR install_sw`.
build_openssl() {
	local dir="$1"
	fetch "$OPENSSL_URL" "$OPENSSL_SHA256" openssl.tgz || return 1
	mkdir -p "$dir" && tar xzf openssl.tgz -C "$dir" --strip-components=1 || return 1
	# No dlopen or mmap'd secure heap in the guest, and no assembly for wasm; providers are built in. Thread support
	# stays on (CPython's _ssl requires it): with one thread, its pthread locks and once-calls simply succeed.
	(cd "$dir" && CC="$WASM_CC" AR="$WORK/bin/ar" RANLIB="$WORK/bin/ranlib" ./Configure linux-generic32 \
		no-asm no-shared no-dso no-module no-async no-afalgeng no-engine no-secure-memory \
		no-tests no-docs --prefix=/usr --openssldir=/etc/ssl --libdir=lib >configure.log 2>&1 \
		&& make -j"$(nproc)" >make.log 2>&1) \
		|| { tail -n 30 "$dir/configure.log" "$dir/make.log"; return 1; }
}
