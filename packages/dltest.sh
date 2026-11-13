# dlopen test: a program and shared objects (tests/fixtures/dlopen), run in the guest by tests/dlopen.mjs.
# Sourced by scripts/build-packages.sh; built only when named (scripts/build.sh packages dltest).
EXPERIMENTAL=1
NAME=dltest
VERSION=1
DEPS=-
DESC="dlopen test program and shared objects (for tests/dlopen.mjs)"

build() {
	local src="$REPO/tests/fixtures/dlopen" lib="$DEST/usr/lib/dltest" obj="$PWD"
	mkdir -p "$DEST/usr/bin" "$lib"
	for f in dltest libone libtwo libbad; do
		cc_compile -c "$src/$f.c" -o "$f.o" || return 1
	done
	# A program that loads shared objects: dlopen itself ($LIBDL), and the whole libc for them to use.
	cc_link dltest.o "$LIBDL" "${WHOLE_LIBC[@]}" -o "$DEST/usr/bin/dltest" || return 1
	python3 "$REPO/scripts/wasm-syms.py" check-program "$DEST/usr/bin/dltest" || return 1
	cc_link_so libone.o -o "$lib/libone.so" || return 1
	# Linked in the library directory, so the needed library is recorded by its file name.
	(cd "$lib" && cc_link_so "$obj/libtwo.o" libone.so -o libtwo.so) || return 1
	cc_link_so libbad.o -o "$lib/libbad.so" || return 1
	# A CPython extension module, if the python package has been built (its build tree has the headers).
	local py="$WORK/python"
	if [ -f "$py/pyconfig.h" ]; then
		mkdir -p "$DEST/usr/lib/python3.12/site-packages"
		cc_compile -I"$py/Include" -I"$py" -c "$src/pydltest.c" -o pydltest.o || return 1
		cc_link_so pydltest.o -o "$DEST/usr/lib/python3.12/site-packages/_dltest.so" || return 1
		python3 "$REPO/scripts/wasm-syms.py" check-so "$py/python" "$DEST/usr/lib/python3.12/site-packages/_dltest.so" || return 1
	fi
}
