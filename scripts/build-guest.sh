#!/bin/bash
# Cross-build the guest side of the host channel (winixd, curl) and stage them, plus /init, in the overlay.
# Called by build.sh (needs its env: LW_WORKSPACE LW_VARIANT BUILD_ROOT SRC REPO OVERLAY).
set -euo pipefail

I="$LW_WORKSPACE/install"
G="$REPO/guest"
OBJ="$BUILD_ROOT/guest"
export REAL_LLVM="$I/llvm/bin"
CC="$SRC/tools/fake-llvm/clang"
CFLAGS=(--target=wasm-linux-musl -march="${LW_VARIANT%%_*}" "--sysroot=$I/musl-$LW_VARIANT" -fPIC -D__linux__
  --rtlib=compiler-rt -O2)

# The fake-llvm wrapper only treats a command as a link (and fixes up -shared) when it sees a -l flag.
build() {
  "$CC" "${CFLAGS[@]}" -c "$G/$1.c" -o "$OBJ/$1.o"
  "$CC" "${CFLAGS[@]}" "-m${LW_VARIANT%%_*}" -shared "$OBJ/$1.o" -o "$2" -lc
  [ -s "$2" ]
}

mkdir -p "$OBJ" "$OVERLAY/sbin" "$OVERLAY/usr/bin"
build winixd "$OVERLAY/sbin/winixd"
build curl "$OVERLAY/usr/bin/curl"
install -m 755 "$G/init" "$OVERLAY/init"
ls -l "$OVERLAY/sbin/winixd" "$OVERLAY/usr/bin/curl"
