# git, built for the guest (not the x86-64 Alpine build under Blink that apt falls back to). Sourced by
# scripts/build-packages.sh. https:// and http:// remotes go through libcurl and OpenSSL over the guest's sockets,
# so they need a `net` transport (see Sockets in the README); local repositories need nothing.
source "$REPO/packages/openssl.inc"
NAME=git
VERSION=2.56.1
DEPS=ca-certificates
DESC="git version control, with https:// and http:// remotes (libcurl, OpenSSL)"
URL=https://mirrors.edge.kernel.org/pub/software/scm/git/git-$VERSION.tar.xz
SHA256=f0b0bf89264b9bd2e1c640363e7529643989da76281600473c50745cd34a607f
ZLIB_URL=https://github.com/madler/zlib/releases/download/v1.3.1/zlib-1.3.1.tar.gz
ZLIB_SHA256=9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23
CURL_VERSION=8.23.0
CURL_URL=https://curl.se/download/curl-$CURL_VERSION.tar.xz
CURL_SHA256=8dadd7d2536a314f982ad05a651b713f426bf7d02cc2c76cffb9796f2218e6c5

build() {
	fetch "$URL" "$SHA256" src.tar.xz
	tar xJf src.tar.xz --strip-components=1
	# The guest has no fork(): commands start through a clone() callback (see the patch). Background work inside
	# git (the sideband demultiplexer of every fetch) runs in threads, as on any modern platform.
	patch -p1 < "$REPO/packages/git-clone-spawn.patch" >/dev/null || return 1

	# zlib, OpenSSL and libcurl as static libraries, in a staging prefix.
	local stage="$PWD/stage/usr"
	fetch "$ZLIB_URL" "$ZLIB_SHA256" zlib.tgz
	mkdir zlibsrc && tar xzf zlib.tgz -C zlibsrc --strip-components=1
	(cd zlibsrc && CC="$WASM_CC" AR="$WORK/bin/ar" RANLIB="$WORK/bin/ranlib" ./configure --static --prefix=/usr >/dev/null \
		&& make -j"$(nproc)" libz.a >/dev/null && make install DESTDIR="$PWD/../stage" >/dev/null) || return 1
	build_openssl "$PWD/opensslsrc" || return 1
	make -C opensslsrc install_dev DESTDIR="$PWD/stage" >/dev/null || return 1

	# libcurl: HTTP(S) only. WINIX_STRICT_LINK makes configure's "is this function there?" links fail for functions
	# the libc lacks (see build-packages.sh); without it every probe succeeds.
	export WINIX_STRICT_LINK=1
	fetch "$CURL_URL" "$CURL_SHA256" curl.tar.xz
	mkdir curlsrc && tar xJf curl.tar.xz -C curlsrc --strip-components=1
	(cd curlsrc && CC="$WASM_CC" AR="$WORK/bin/ar" RANLIB="$WORK/bin/ranlib" \
		CPPFLAGS="-I$stage/include" LDFLAGS="-L$stage/lib" \
		./configure --host=wasm32-linux-musl --build=x86_64-pc-linux-gnu --prefix=/usr \
		--disable-shared --enable-static --with-openssl="$stage" --with-zlib="$stage" \
		--with-ca-bundle=/etc/ssl/cert.pem --without-ca-path \
		--disable-threaded-resolver --disable-ipv6 --disable-manual --disable-docs --disable-ldap --disable-ldaps \
		--disable-rtsp --disable-dict --disable-telnet --disable-tftp --disable-pop3 --disable-imap --disable-smb \
		--disable-smtp --disable-gopher --disable-mqtt --disable-ftp --disable-file --disable-ntlm --disable-unix-sockets \
		--disable-websockets --disable-alt-svc --disable-hsts --disable-libcurl-option \
		--without-libpsl --without-brotli --without-zstd --without-nghttp2 --without-libidn2 --without-librtmp \
		--without-libssh2 --without-ngtcp2 --without-nghttp3 >configure.log 2>&1 \
		&& make -j"$(nproc)" -C lib >make.log 2>&1 && make -C lib install DESTDIR="$PWD/../stage" >/dev/null \
		&& make -C include install DESTDIR="$PWD/../stage" >/dev/null) \
		|| { tail -n 30 curlsrc/configure.log curlsrc/make.log; return 1; }
	unset WINIX_STRICT_LINK

	# git's own build. uname_* say what the result runs on (the Makefile would ask the build host). musl's regex
	# lacks REG_STARTEND (so git's own is used); file contents are read rather than mapped (no MMU); the fsmonitor
	# daemon needs kernel headers the sysroot does not have; no Rust for this target.
	cat > config.mak <<-MAK
	CC = $WASM_CC
	AR = $WORK/bin/ar
	CFLAGS = -O2 -I$stage/include
	LDFLAGS = -L$stage/lib
	prefix = /usr
	gitexecdir = libexec/git-core
	template_dir = share/git-core/templates
	sysconfdir = /etc
	CURL_CONFIG = false
	CURL_CFLAGS = -I$stage/include
	CURL_LDFLAGS = -L$stage/lib -lcurl -lssl -lcrypto -lz
	NO_GETTEXT = 1
	NO_PERL = 1
	NO_PYTHON = 1
	NO_TCLTK = 1
	NO_EXPAT = 1
	NO_ICONV = 1
	NO_OPENSSL = 1
	NO_MMAP = 1
	NO_RUST = 1
	NO_REGEX = NeedsStartEnd
	NO_INSTALL_HARDLINKS = 1
	INSTALL_SYMLINKS = 1
	MAK
	local args=(uname_S=Linux uname_M=wasm32 uname_O=GNU/Linux uname_R=7.0 FSMONITOR_DAEMON_BACKEND= FSMONITOR_OS_SETTINGS= LINK_FUZZ_PROGRAMS=)
	make -j"$(nproc)" "${args[@]}" all >make.log 2>&1 || { grep -B2 -A8 -m3 "error" make.log || tail -30 make.log; return 1; }
	make "${args[@]}" DESTDIR="$DEST" install >install.log 2>&1 || { tail -30 install.log; return 1; }

	# Programs written in Perl, Tcl or shell that need tools the guest does not have.
	rm -rf "$DEST/usr/share/gitweb" "$DEST/usr/share/git-gui" "$DEST/usr/share/gitk"
	rm -f "$DEST"/usr/bin/{git-cvsserver,gitk,git-shell} "$DEST"/usr/libexec/git-core/{git-cvsserver,git-instaweb,git-request-pull,git-filter-branch,git-quiltimport}
	# Servers and rarely used clients, each a multi-megabyte program of its own: the daemon and the HTTP backend, the
	# IMAP sender, scalar, and the walker for "dumb" HTTP remotes (smart HTTP, what hosts serve, is git-remote-http).
	rm -f "$DEST"/usr/bin/scalar "$DEST"/usr/libexec/git-core/{scalar,git-daemon,git-http-backend,git-imap-send,git-http-fetch,git-shell}
	for f in "$DEST/usr/bin/git" "$DEST/usr/libexec/git-core/git-remote-http"; do
		[ -f "$f" ] && [ ! -L "$f" ] || continue
		python3 "$REPO/scripts/wasm-syms.py" check-program "$f" || return 1
		"$WORK/bin/strip" "$f" 2>/dev/null || true
		# Tree walks, diffs and merges recurse: a 2 MiB stack instead of the default 256 KiB (patches/kernel/0006).
		set_stack_size "$f" $((2 << 20)) || return 1
	done
	# The guest runs as root in directories the host may have written: every repository is the user's own.
	mkdir -p "$DEST/etc"
	# And no fork(), so maintenance after a commit or a fetch runs in the foreground instead of detaching.
	printf '[safe]\n\tdirectory = *\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n[maintenance]\n\tautoDetach = false\n[gc]\n\tautoDetach = false\n' > "$DEST/etc/gitconfig"
}
