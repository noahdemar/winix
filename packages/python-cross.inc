# A Python for building extension modules: it runs on the build machine but describes the guest's CPython, so build
# systems that ask the interpreter how to build (meson's python module, sysconfig users) get the guest's answers.
# Shared by recipes with extension modules (not a recipe itself: build-packages.sh only builds packages/*.sh).
#
# python_cross_env sets PYTHON_CROSS to that interpreter, and exports the variables that make its sysconfig load
# the guest's build-time data: the extension suffix, the platform (linux-wasm32), and an include directory holding
# the guest's pyconfig.h. It is the host interpreter the python recipe built to cross-compile with (same version as
# the guest's, so the python package must be built first, and without WINIX_HOST_PYTHON), completed with its own
# extension modules and installed under $WORK/python-cross.
python_cross_env() {
	local py="$WORK/python" cross="$WORK/python-cross" data
	[ -f "$py/pyconfig.h" ] && [ -x "$py/hostsrc/python" ] \
		|| { echo "$NAME: build the python package first (scripts/build.sh packages python $NAME)"; return 1; }
	if [ ! -x "$cross/bin/python3" ] || [ "$py/pyconfig.h" -nt "$cross/bin/python3" ]; then
		rm -rf "$cross"
		(cd "$py/hostsrc" && env -i PATH=/usr/bin:/bin HOME="$HOME" make -j"$(nproc)" >make-all.log 2>&1 \
			&& env -i PATH=/usr/bin:/bin HOME="$HOME" make install prefix="$cross" exec_prefix="$cross" >install.log 2>&1) \
			|| { tail -n 20 "$py/hostsrc/make-all.log" "$py/hostsrc/install.log"; return 1; }
		# The guest's configuration header in place of the build machine's (the other headers are the same source).
		cp "$py/pyconfig.h" "$cross/include/python3.12/pyconfig.h" || return 1
		# The guest's sysconfig data, with its header directories (/usr/include/python3.12 in the guest, which may
		# exist on the build machine and hold another Python's headers) pointing here.
		mkdir -p "$cross/guest"
		data="$(echo "$py/$(cat "$py/pybuilddir.txt")"/_sysconfigdata_*.py)"
		sed "s|'/usr/include/python3.12'|'$cross/include/python3.12'|" "$data" > "$cross/guest/$(basename "$data")" || return 1
	fi
	PYTHON_CROSS="$cross/bin/python3"
	export _PYTHON_SYSCONFIGDATA_NAME="$(basename "$cross"/guest/_sysconfigdata_*.py .py)"
	export _PYTHON_HOST_PLATFORM=linux-wasm32
	export PYTHONPATH="$cross/guest"
	[ "$("$PYTHON_CROSS" -c 'import sysconfig; print(sysconfig.get_config_var("EXT_SUFFIX"), sysconfig.get_platform())')" \
		= ".cpython-312.so linux-wasm32" ] || { echo "$NAME: the cross Python does not report the guest's configuration"; return 1; }
}

# check_extension_modules DIR: every shared object under DIR must find what it imports among the guest python's
# exports (or its own): an extension that calls a function the guest lacks otherwise fails only when imported.
check_extension_modules() {
	find "$1" -name '*.so' -print0 | xargs -0 python3 "$REPO/scripts/wasm-syms.py" check-so "$WORK/python/python"
}
