#!/bin/bash
# Build the apt repository: each packages/<name>.sh recipe is built with the guest toolchain into
# $D/pkgs/<name>_<version>.tar.gz, and $D/pkgs/index.txt lists them (format: see guest/apt).
# Called by build.sh (needs its env: LW_WORKSPACE LW_VARIANT BUILD_ROOT SRC REPO). Usage: [D=dist] build-packages.sh [name...]
set -euo pipefail

I="$LW_WORKSPACE/install"
OUT="${D:-$REPO/dist}/pkgs"
WORK="$BUILD_ROOT/pkgs"
DL="$BUILD_ROOT/dl"
export REAL_LLVM="$I/llvm/bin"
CC="$SRC/tools/fake-llvm/clang"
CFLAGS=(--target=wasm-linux-musl -march="${LW_VARIANT%%_*}" "--sysroot=$I/musl-$LW_VARIANT" -fPIC -D__linux__
  --rtlib=compiler-rt -O2)
mkdir -p "$OUT" "$WORK" "$DL"

# fetch URL SHA256 FILE: download once into $DL, verify, copy to FILE. An empty SHA256 prints the hash to pin.
fetch() {
  local cache="$DL/$(basename "$1")"
  [ -f "$cache" ] || curl -fsSL -o "$cache" "$1"
  local got
  got=$(sha256sum "$cache" | cut -d ' ' -f 1)
  if [ -z "$2" ]; then echo "  $NAME: pin SHA256=$got"; elif [ "$got" != "$2" ]; then echo "$NAME: hash mismatch for $1"; exit 1; fi
  cp "$cache" "$3"
}
cc_compile() { "$CC" "${CFLAGS[@]}" "$@"; }
# The fake-llvm wrapper only treats a command as a link when it sees a -l flag.
cc_link() { "$CC" "${CFLAGS[@]}" "-m${LW_VARIANT%%_*}" -shared "$@" -lc; }
export -f fetch cc_compile cc_link
export CC LW_VARIANT DL

recipes=()
if [ $# -gt 0 ]; then for n; do recipes+=("$REPO/packages/$n.sh"); done; else recipes=("$REPO"/packages/*.sh); fi

for r in "${recipes[@]}"; do
  (
    source "$r"
    B="$WORK/$NAME"
    export DEST="$B/root" NAME
    rm -rf "$B" && mkdir -p "$DEST" && cd "$B"
    echo "building $NAME $VERSION"
    build > "$B/build.log" 2>&1 || { tail -30 "$B/build.log"; exit 1; }
    grep -h "pin SHA256" "$B/build.log" || true
    rm -f "$OUT/${NAME}_"*.tar.gz
    tar czf "$OUT/${NAME}_$VERSION.tar.gz" --owner=0 --group=0 -C "$DEST" .
    f="$OUT/${NAME}_$VERSION.tar.gz"
    echo "$NAME $VERSION $(sha256sum "$f" | cut -d ' ' -f 1) $(stat -c %s "$f") $DEPS $DESC" > "$WORK/$NAME.entry"
  )
done

cat "$WORK"/*.entry | sort > "$OUT/index.txt"
cat "$OUT/index.txt"
