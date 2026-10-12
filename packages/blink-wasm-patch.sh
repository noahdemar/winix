#!/bin/bash
# Regenerates packages/blink-wasm.patch from packages/blink-wasm-patch.py (run in WSL; needs the blink tarball in ~/winix-build/dl).
set -e
R="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T=$(mktemp -d); cd $T
tar xzf $HOME/winix-build/dl/blink-1.1.0.tar.gz --strip-components=1 blink-1.1.0/blink/map.c blink-1.1.0/blink/memorymalloc.c blink-1.1.0/blink/loader.c blink-1.1.0/blink/syscall.c blink-1.1.0/blink/blink.c blink-1.1.0/blink/machine.c blink-1.1.0/blink/machine.h
mkdir -p a/blink b/blink; cp blink/*.[ch] a/blink/; cp blink/*.[ch] b/blink/
python3 $R/packages/blink-wasm-patch.py b
diff -ru a b | sed -e 's#^\(---\|+++\) \([ab]/blink/[a-z]*\.[ch]\).*#\1 \2#' -e '/^diff -ru/d' > $R/packages/blink-wasm.patch || true
