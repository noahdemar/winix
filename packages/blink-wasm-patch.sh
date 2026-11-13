#!/bin/bash
# Regenerates packages/blink-wasm.patch from packages/blink-wasm-patch.py and packages/blink-jitwasm.c
# (run in WSL; needs the blink tarball in ~/winix-build/dl, which build-packages.sh downloads).
set -e
R="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
cd "$T"
tar xzf "$HOME/winix-build/dl/blink-1.1.0.tar.gz" --strip-components=1 blink-1.1.0/blink
mkdir a b && cp -r blink a/ && cp -r blink b/
python3 "$R/packages/blink-wasm-patch.py" b
diff -ruN a b | sed -e 's#^\(---\|+++\) \([ab]/blink/[a-z0-9]*\.\(c\|h\|inc\)\).*#\1 \2#' -e '/^diff -ruN/d' \
  > "$R/packages/blink-wasm.patch" || true
grep '^+++' "$R/packages/blink-wasm.patch"
