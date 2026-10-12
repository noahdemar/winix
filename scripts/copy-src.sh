#!/bin/bash
# Refresh the browser side of dist/ without rebuilding the kernel: upstream runtime/ with patches/runtime/*.patch
# applied, then the host-API files from src/ (flat, next to linux.js). Usage: copy-src.sh [dest=dist]
set -euo pipefail
R="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
D="${1:-$R/dist}"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
git -C "$R/third_party/linux-wasm" archive HEAD runtime | tar -x -C "$T"
for p in "$R"/patches/runtime/*.patch; do
  [ -f "$p" ] || continue
  git -C "$T" apply "$p"
done
mkdir -p "$D" && cp "$T"/runtime/* "$D/" && cp "$R"/src/* "$D/"
