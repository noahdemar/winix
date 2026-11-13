# pandas for the guest's CPython, with the pure-Python packages it needs at run time (python-dateutil, six, and
# tzdata: the guest has no system time zone database). Sourced by scripts/build-packages.sh; built after numpy,
# whose build tree it takes numpy's headers, its copy of meson and Cython from.
source "$REPO/packages/python-cross.inc"
NAME=pandas
VERSION=3.1.1
DEPS=numpy
DESC="pandas: data frames and data analysis for Python (with python-dateutil, six and tzdata)"
URL=https://files.pythonhosted.org/packages/17/ca/24c6bc92aca3d366146358e47f1d374c0e1a50763ef226fc71eff20a63fb/pandas-$VERSION.tar.gz
SHA256=05fed3e3b7c99b226f160e29d7d6cb7ef39638c758cbfe42b3f24ba34f04b859
DATEUTIL_URL=https://files.pythonhosted.org/packages/2f/a9/52b89563d154433d79b51ed1eb4842bf7334cb2696891a7fe135618853d7/python_dateutil-4.0.0-py3-none-any.whl
DATEUTIL_SHA256=a5e246f79eb80475e691bf93862cead98decd8a498cf53ba0516fcdc0f50dc1c
SIX_URL=https://files.pythonhosted.org/packages/b7/ce/149a00dd41f10bc29e5921b496af8b574d8413afcd5e30dfa0ed46c2cc5e/six-1.17.0-py2.py3-none-any.whl
SIX_SHA256=4721f391ed90541fddacab5acf947aa0d3dc7d27b2e1e8eda2be8970586c3274
TZDATA_URL=https://files.pythonhosted.org/packages/0a/66/9a06c2227fedfd4919f0eaaa8b94377d9730882a7e4f95823c9a331ab5e1/tzdata-2026.6-py2.py3-none-any.whl
TZDATA_SHA256=0a10eec6e13ef16b627fabed9a5f2ba61a62b1c67f327305f4e7e412a70b4aec

build() {
	python_cross_env || return 1
	local np="$WORK/numpy" npsite
	npsite="$np/root/usr/lib/python3.12/site-packages/numpy"
	[ -f "$npsite/_core/include/numpy/arrayobject.h" ] && [ -f "$np/cython/cython.py" ] \
		|| { echo "pandas: build the numpy package first (scripts/build.sh packages numpy pandas)"; return 1; }
	fetch "$URL" "$SHA256" src.tar.gz
	tar xzf src.tar.gz --strip-components=1
	# The guest's Python has no ctypes (libffi has no port to it). pandas imports it at startup in two modules: to
	# word an error message on Windows, and for the dataframe interchange protocol, which then cannot be used.
	local f
	for f in $(grep -rl --include='*.py' --exclude-dir=tests '^import ctypes$' pandas); do
		sed -i 's/^import ctypes$/try:\n    import ctypes\nexcept ImportError:\n    ctypes = None/' "$f" || return 1
	done
	grep -q '^    ctypes = None' pandas/errors/__init__.py || { echo "pandas: errors/__init__.py no longer imports ctypes"; return 1; }

	# pandas' build imports numpy to ask where its headers are. The guest's numpy cannot be imported on the build
	# machine, so a stand-in answers with the guest numpy's header directory and version.
	mkdir -p shim/numpy
	cat > shim/numpy/__init__.py <<-PY
	__version__ = "$(sed -n 's/^VERSION=//p' "$REPO/packages/numpy.sh")"
	def get_include():
	    return "$npsite/_core/include"
	PY
	# Cython looks for numpy's declarations (numpy/*.pxd) in the same place.
	cp "$npsite"/*.pxd shim/numpy/ || return 1
	# Its version script imports versioneer, which reads the version from git or from the sdist's metadata: the
	# stand-in gives the version being built.
	cat > shim/versioneer.py <<-PY
	def get_version():
	    return "$VERSION"
	def get_versions():
	    return {"version": "$VERSION", "full-revisionid": "", "dirty": False, "error": None, "date": None}
	PY
	# (Its template generator also imports Cython itself, from numpy's unpacked copy.)
	export PYTHONPATH="$PWD/shim:$np/cython:$PYTHONPATH"
	# Its build scripts run "python3" from PATH.
	local PATH="$(dirname "$PYTHON_CROSS"):$PATH"

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
	INI
	cat > native.ini <<-INI
	[binaries]
	cython = ['$PYTHON_CROSS', '$np/cython/cython.py']
	INI
	export WINIX_STRICT_LINK=1
	local meson=("$PYTHON_CROSS" "$np/vendored-meson/meson/meson.py")
	"${meson[@]}" setup build --cross-file cross.ini --native-file native.ini --prefix=/usr --buildtype=release \
		-Db_lundef=false >setup.log 2>&1 || { tail -n 40 setup.log; return 1; }
	"${meson[@]}" compile -C build -j "$(nproc)" >compile.log 2>&1 \
		|| { grep -B4 -A12 -m3 -E "error:|FAILED" compile.log || tail -n 40 compile.log; return 1; }
	"${meson[@]}" install -C build --no-rebuild --destdir "$DEST" >install.log 2>&1 || { tail -n 20 install.log; return 1; }
	unset WINIX_STRICT_LINK

	local site="$DEST/usr/lib/python3.12/site-packages"
	[ -f "$site/pandas/__init__.py" ] || { echo "pandas was not installed into $site"; return 1; }
	check_extension_modules "$site" || return 1
	find "$site/pandas" -depth -name tests -type d -exec rm -rf {} +
	find "$site/pandas" -name '*.so' -exec "$WORK/bin/strip" {} + 2>/dev/null || true

	# Its pure-Python dependencies, unpacked from their wheels.
	fetch "$DATEUTIL_URL" "$DATEUTIL_SHA256" dateutil.whl || return 1
	fetch "$SIX_URL" "$SIX_SHA256" six.whl || return 1
	fetch "$TZDATA_URL" "$TZDATA_SHA256" tzdata.whl || return 1
	for w in dateutil six tzdata; do
		python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$w.whl" "$site" || return 1
	done
}
