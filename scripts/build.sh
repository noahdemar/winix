#!/bin/bash
# Build winix artifacts. Run from WSL (Ubuntu). Output: <repo>/dist/
# Usage: scripts/build.sh [all|kernel|busybox|quickjs]
#   all      (default) fetch, LLVM, kernel, musl, busybox, initramfs; refresh dist/
#   kernel   apply patches, rebuild kernel only -> dist/vmlinux-*.wasm
#   busybox  apply patches/config, rebuild busybox + initramfs (+ overlay) -> dist/initramfs-*.cpio.gz
#   quickjs  rebuild qjs, repack initramfs with the overlay
#   guest    rebuild winixd + curl (guest/), repack initramfs with the overlay
# Builds on the native Linux fs (~/winix-build) because /mnt/c is slow and paths must not contain spaces.
set -euo pipefail

TARGET="${1:-all}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUB="$REPO/third_party/linux-wasm"
BUILD_ROOT="${WINIX_BUILD:-$HOME/winix-build}"
export LW_WORKSPACE="$BUILD_ROOT/workspace"
export LW_VARIANT="${LW_VARIANT:-wasm32_nommu}"
export LW_JOBS_LLVM_LINK="${LW_JOBS_LLVM_LINK:-2}"
export LW_JOBS_LLVM_COMPILE="${LW_JOBS_LLVM_COMPILE:-12}"
export LW_JOBS_KERNEL_COMPILE="${LW_JOBS_KERNEL_COMPILE:-$(nproc)}"
export LW_JOBS_MUSL_COMPILE="${LW_JOBS_MUSL_COMPILE:-$(nproc)}"
export LW_JOBS_BUSYBOX_COMPILE="${LW_JOBS_BUSYBOX_COMPILE:-$(nproc)}"

export PATH="$HOME/.local/bin:$PATH"
# `git am` in linux-wasm.sh needs an identity
export GIT_AUTHOR_NAME=winix GIT_AUTHOR_EMAIL=winix@localhost GIT_COMMITTER_NAME=winix GIT_COMMITTER_EMAIL=winix@localhost
for t in git cmake ninja python3 flex bison bc rsync cpio gcc make; do
  command -v "$t" >/dev/null || { echo "missing: $t (sudo apt install -y build-essential git cmake ninja-build python3 flex bison bc rsync cpio; or pip3 install --user ninja)"; exit 1; }
done

# git archive gives LF line endings regardless of the Windows checkout's autocrlf
SRC="$BUILD_ROOT/linux-wasm"
rm -rf "$SRC" && mkdir -p "$SRC"
git -C "$SUB" archive HEAD | tar -x -C "$SRC"
cd "$SRC"

for c in llvm kernel musl busybox; do
  if [ ! -f "$LW_WORKSPACE/src/$c/.fetched" ]; then
    rm -rf "$LW_WORKSPACE/src/$c"
    if [ $c = kernel ]; then
      # git 2.34 (Ubuntu 22.04) fails on the script's --shallow-exclude clone of the kernel; same tree via --depth
      git clone -b wasm-7.0 --depth 30 --single-branch --no-tags https://github.com/joelseverin/linux.git "$LW_WORKSPACE/src/kernel"
    else
      ./linux-wasm.sh fetch-$c
    fi
    touch "$LW_WORKSPACE/src/$c/.fetched"
  fi
done

# Our patches (patches/<component>/*.patch) go on top of upstream's; skipped when already applied.
for c in kernel busybox; do
  for p in "$REPO"/patches/$c/*.patch; do
    [ -f "$p" ] || continue
    if git -C "$LW_WORKSPACE/src/$c" apply --reverse --check "$p" >/dev/null 2>&1; then continue; fi
    git -C "$LW_WORKSPACE/src/$c" apply "$p"
    echo "applied $(basename "$p") to $c"
  done
done

I="$LW_WORKSPACE/install"
D="${WINIX_DIST:-$REPO/dist}"
OVERLAY="$BUILD_ROOT/overlay-$LW_VARIANT"
mkdir -p "$D"

# BusyBox: upstream's wasm defconfig with patches/busybox/winix.config merged over it
apply_busybox_config() {
  local bb="$LW_WORKSPACE/src/busybox"
  git -C "$bb" show HEAD:configs/wasm_defconfig > "$BUILD_ROOT/wasm_defconfig.orig"
  python3 - "$BUILD_ROOT/wasm_defconfig.orig" "$REPO/patches/busybox/winix.config" "$bb/configs/wasm_defconfig" <<'PY'
import re, sys
base, frag, out = sys.argv[1:]
sym = lambda l: (re.match(r'^(?:# )?(CONFIG_\w+)(?: is not set|=)', l) or [None, None])[1]
fl = [l for l in open(frag).read().splitlines() if sym(l)]
drop = {sym(l) for l in fl}
keep = [l for l in open(base).read().splitlines() if sym(l) not in drop]
open(out, 'w').write('\n'.join(keep + fl) + '\n')
PY
}

# Extra programs (qjs) staged in $OVERLAY, plus repo overlay/, are appended to upstream's initramfs
pack_overlay() {
  local gz="$I/initramfs-$LW_VARIANT/initramfs.cpio.gz" tmp="$BUILD_ROOT/initramfs.cpio" dir
  gunzip -c "$gz" > "$tmp"
  for dir in "$OVERLAY" "$REPO/overlay"; do
    [ -d "$dir" ] || continue
    (cd "$dir" && find . -mindepth 1 \( -type f -o -type l \) -print0 | cpio --null -o --format=newc -A -O "$tmp" 2>/dev/null)
  done
  gzip -c "$tmp" > "$gz" && rm -f "$tmp"
}

export OVERLAY SRC REPO BUILD_ROOT
case "$TARGET" in
  kernel)
    ./linux-wasm.sh build-kernel
    ;;
  busybox|quickjs|guest)
    [ "$TARGET" = busybox ] && { apply_busybox_config; rm -rf "$I/busybox-$LW_VARIANT"; ./linux-wasm.sh build-busybox; }
    ./linux-wasm.sh build-initramfs
    if [ "$TARGET" = quickjs ] || [ ! -x "$OVERLAY/usr/bin/qjs" ]; then "$REPO/scripts/build-quickjs.sh"; fi
    "$REPO/scripts/build-guest.sh"
    pack_overlay
    ;;
  all)
    # LLVM's second build fails in runtimes; retry works
    if [ ! -x "$I/llvm/bin/clang" ]; then
      ./linux-wasm.sh build-llvm || ./linux-wasm.sh build-llvm
    fi
    apply_busybox_config
    rm -rf "$I/busybox-$LW_VARIANT" # drop stale applet symlinks
    ./linux-wasm.sh build-os
    "$REPO/scripts/build-quickjs.sh"
    "$REPO/scripts/build-guest.sh"
    pack_overlay
    # runtime/ (with patches/runtime applied) and src/ are copied by copy-src.sh below
    ;;
  *) echo "unknown target: $TARGET"; exit 1 ;;
esac

# runtime/index.html fetches variant-suffixed names
case "$TARGET" in kernel|all) cp "$I/kernel-$LW_VARIANT/vmlinux.wasm" "$D/vmlinux-$LW_VARIANT.wasm" ;; esac
case "$TARGET" in busybox|quickjs|guest|all) cp "$I/initramfs-$LW_VARIANT/initramfs.cpio.gz" "$D/initramfs-$LW_VARIANT.cpio.gz" ;; esac
ls -l "$D"
"$REPO/scripts/copy-src.sh" "$D"
