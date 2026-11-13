#!/bin/bash
# Refresh the browser side of dist/ without rebuilding the kernel: upstream runtime/ (only linux.js, linux-worker.js
# and xterm) with patches/runtime/*.patch applied, then the pages and host API from src/. Usage: copy-src.sh [dest=dist]
set -euo pipefail
R="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
D="${1:-$R/dist}"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
git -C "$R/third_party/linux-wasm" -c core.autocrlf=false archive HEAD runtime | tar -x -C "$T"
for p in "$R"/patches/runtime/*.patch; do
  [ -f "$p" ] || continue
  git -C "$T" -c core.autocrlf=false apply "$p"
done
mkdir -p "$D"
rm -f "$D"/{bright.css,server.py,boot-log.txt}
cp "$T"/runtime/{linux.js,linux-worker.js,xterm.js,xterm.css} "$D/" && cp "$R"/src/* "$D/"
