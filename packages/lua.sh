# Lua interpreter (lua). Sourced by scripts/build-packages.sh, which provides fetch, cc_compile, cc_link, $DEST.
NAME=lua
VERSION=5.4.7
DEPS=-
DESC="Lua 5.4 scripting language interpreter"
URL=https://www.lua.org/ftp/lua-$VERSION.tar.gz
SHA256=9fbf5e28ef86c69858f6d3d34eccc32e911c1a28b4120ff3e84aaa70cfbf1e30

build() {
	fetch "$URL" "$SHA256" src.tar.gz
	tar xzf src.tar.gz --strip-components=1
	objs=()
	for f in src/*.c; do
		case $f in src/luac.c) continue ;; esac
		cc_compile -DLUA_USE_POSIX -c "$f" -o "${f%.c}.o"
		objs+=("${f%.c}.o")
	done
	mkdir -p "$DEST/usr/bin"
	cc_link "${objs[@]}" -o "$DEST/usr/bin/lua" -lm
}
