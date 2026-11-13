# NumPy for the guest's CPython, as extension modules loaded with dlopen (guest/dl.c). Sourced by
# scripts/build-packages.sh; needs the python package's build tree and the C++ library (scripts/build.sh libcxx).
source "$REPO/packages/python-cross.inc"
NAME=numpy
VERSION=2.5.4
DEPS=python
DESC="NumPy: arrays and numerical computing for Python (no BLAS: numpy's own, slower, linear algebra)"
URL=https://files.pythonhosted.org/packages/95/b0/c7453d0b6e2073c3264468b106ee1563750cecc910965e67357e3698c83e/numpy-$VERSION.tar.gz
SHA256=9a94cf751c9ad8ebaa835bcd3d40dacf8534ad086b88c38029b65123c7999d2a
CYTHON_URL=https://files.pythonhosted.org/packages/99/ca/18e324972e5cac914816fdd7bb03e19a455b90039c277a538f7781b50c85/cython-3.3.1.tar.gz
CYTHON_SHA256=e0e45989e821bef6aa9ae15c7d583ab5e055f7406c4b3624e49e06d24e90375a

build() {
	python_cross_env || return 1
	fetch "$URL" "$SHA256" src.tar.gz
	tar xzf src.tar.gz --strip-components=1
	# Cython turns numpy's .pyx files into C. It runs from its source tree, as plain Python.
	fetch "$CYTHON_URL" "$CYTHON_SHA256" cython.tar.gz
	mkdir cython && tar xzf cython.tar.gz -C cython --strip-components=1

	# numpy builds with its own copy of meson. The cross file names the guest toolchain; long double's format is
	# given because finding it out means running a guest program.
	cat > cross.ini <<-INI
	[binaries]
	c = '$WORK/bin/cc'
	cpp = '$WORK/bin/c++'
	ar = '$WORK/bin/ar'
	strip = '$WORK/bin/strip'

	[host_machine]
	system = 'linux'
	cpu_family = 'wasm32'
	cpu = 'wasm32'
	endian = 'little'

	[properties]
	longdouble_format = 'IEEE_QUAD_LE'
	INI
	# Tools that run on the build machine go in a native file.
	cat > native.ini <<-INI
	[binaries]
	cython = ['$PYTHON_CROSS', '$PWD/cython/cython.py']
	INI
	# meson asks whether functions exist by linking a call to each: only meaningful if undefined symbols fail.
	export WINIX_STRICT_LINK=1
	local meson=("$PYTHON_CROSS" vendored-meson/meson/meson.py)
	"${meson[@]}" setup build --cross-file cross.ini --native-file native.ini --prefix=/usr --buildtype=release -Db_lundef=false \
		-Dallow-noblas=true -Dblas=none -Dlapack=none -Dcpu-baseline=none -Dcpu-dispatch=none >setup.log 2>&1 \
		|| { tail -n 40 setup.log; return 1; }
	"${meson[@]}" compile -C build -j "$(nproc)" >compile.log 2>&1 \
		|| { grep -B4 -A12 -m3 -E "error:|FAILED" compile.log || tail -n 40 compile.log; return 1; }
	"${meson[@]}" install -C build --no-rebuild --destdir "$DEST" >install.log 2>&1 || { tail -n 20 install.log; return 1; }
	unset WINIX_STRICT_LINK

	local site="$DEST/usr/lib/python3.12/site-packages"
	[ -f "$site/numpy/__init__.py" ] || { echo "numpy was not installed into $site"; return 1; }
	check_extension_modules "$site" || return 1
	# Test suites and the build's own tools are most of the package's size, and nothing here runs them.
	find "$site/numpy" -depth \( -name tests -o -name '_pyinstaller' \) -type d -exec rm -rf {} +
	find "$site/numpy" -name '*.so' -exec "$WORK/bin/strip" {} + 2>/dev/null || true
	rm -rf "$DEST/usr/bin"
}
