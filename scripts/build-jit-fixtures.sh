#!/bin/bash
# Builds the Blink JIT regression fixtures (tests/fixtures/<name>.{c,S}) with the host gcc, checks each one's
# native output against tests/fixtures/<name>.expected, and copies the test pages into the output dir:
#   <dest>/fixtures/<name>.bin and <dest>/<name>.html for name in jit-indirect jit-trace.
# Usage: scripts/build-jit-fixtures.sh [dest=<repo>/dist]   (WSL or Linux only; no Blink or runtime rebuild)
# Expects <dest> to already hold the runtime and the package repo (<dest>/winix.js, <dest>/pkgs/index.txt).
set -euo pipefail

R="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
D="${1:-$R/dist}"
NAMES="jit-indirect jit-trace"

fail() { echo "build-jit-fixtures: $*" >&2; exit 1; }

case "$(uname -s)" in
  Linux) ;;
  *) fail "needs a Linux host (WSL Ubuntu from Windows): the fixtures are built with the host gcc" ;;
esac
command -v gcc >/dev/null || fail "gcc not found (sudo apt install -y build-essential)"
[ -d "$D" ] || fail "destination $D does not exist (build dist first: scripts/build.sh)"
[ -f "$D/winix.js" ] || fail "$D/winix.js missing: $D is not a built winix dist"
[ -f "$D/pkgs/index.txt" ] || fail "$D/pkgs/index.txt missing: the package repo is needed for 'apt install blink'"
[ -f "$D/linux.js" ] || fail "$D/linux.js missing: the runtime is needed"

mkdir -p "$D/fixtures"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
for name in $NAMES; do
  for f in "tests/fixtures/$name.c" "tests/fixtures/$name.S" "tests/fixtures/$name.expected" "tests/$name.html"; do
    [ -f "$R/$f" ] || fail "missing source $R/$f"
  done
  (cd "$R/tests/fixtures" && gcc -O2 -ffreestanding -fno-builtin -fno-stack-protector -fno-pie -static -nostdlib -no-pie \
    -o "$TMP/$name.bin" "$name.c" "$name.S")
  # Native sanity check: the fixture must print the expected lines before it is handed to blink.
  "$TMP/$name.bin" | diff - "$R/tests/fixtures/$name.expected" || fail "native run of $name does not match its expected output"
  cp "$TMP/$name.bin" "$D/fixtures/$name.bin"
  cp "$R/tests/$name.html" "$D/$name.html"
  ls -l "$D/fixtures/$name.bin" "$D/$name.html"
done
