# pip, unpacked from its wheel into python's site-packages. Sourced by scripts/build-packages.sh.
# Pure-Python packages install; those with C extensions cannot run (no dlopen), and pip does not pick binary wheels,
# since the guest's platform tag (linux_wasm32) matches none.
NAME=pip
VERSION=26.2.1
DEPS=python
DESC="pip, the Python package installer (pure-Python packages)"
URL=https://files.pythonhosted.org/packages/f3/6e/1736e5b4ae2b778ef2f81c47d797de9f891d4d8acb047a24ca37a60294dd/pip-$VERSION-py3-none-any.whl
SHA256=71138adf1f4ca900cdb7d289c21b7494329f2332b6d85f0e1c42108c0384ed3e

build() {
	fetch "$URL" "$SHA256" pip.whl || return 1
	local site="$DEST/usr/lib/python3.12/site-packages"
	mkdir -p "$site" "$DEST/usr/bin" "$DEST/etc"
	python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' pip.whl "$site" || return 1
	for n in pip pip3 pip3.12; do
		printf '#!/usr/bin/python3\nimport sys\nfrom pip._internal.cli.main import main\nsys.exit(main())\n' > "$DEST/usr/bin/$n"
		chmod 755 "$DEST/usr/bin/$n"
	done
	# The guest runs everything as root, and has no use for pip's self-update check.
	printf '[global]\nroot-user-action = ignore\ndisable-pip-version-check = true\n' > "$DEST/etc/pip.conf"
}
