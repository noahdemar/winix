#!/bin/bash
# Build the C++ standard library (LLVM's libc++, with libc++abi inside it) for the guest and install it into the
# musl sysroot, so that packages with C++ sources compile: headers in include/c++/v1, and a static,
# position-independent lib/libc++.a that a program or a shared object links in. Its symbols are hidden ("hermetic"),
# so each shared object gets a private copy that it calls directly, exporting none of it.
# Built without exception support: code that throws or catches needs -fno-exceptions, or does not link.
# Called by build.sh (needs its env: LW_WORKSPACE LW_VARIANT BUILD_ROOT). The LLVM sources are the toolchain's own.
set -euo pipefail

I="$LW_WORKSPACE/install"
ARCH="${LW_VARIANT%%_*}"
SYSROOT="${WINIX_SYSROOT:-$I/musl-$LW_VARIANT}"
LLVM_SRC="${WINIX_LLVM_SRC:-$LW_WORKSPACE/src/llvm}"
LLVM_BIN="${WINIX_LLVM_BIN:-$I/llvm/bin}"
KERNEL_HEADERS="${WINIX_KERNEL_HEADERS:-$I/kernel-$LW_VARIANT/include}"
B="$BUILD_ROOT/libcxx-$LW_VARIANT"
GENERATOR="${WINIX_CMAKE_GENERATOR:-Ninja}"

# The flags guest code is compiled with (tools/fake-llvm's wrapper adds the same features and defines), plus the
# kernel's headers: libc++ waits on futexes directly.
FLAGS="--target=$ARCH-unknown-unknown --sysroot=$SYSROOT -fPIC -D__linux__ -D__unix__ -D__unix -matomics -mbulk-memory"
FLAGS="$FLAGS -isystem $KERNEL_HEADERS"

rm -rf "$B"
cmake -G "$GENERATOR" -S "$LLVM_SRC/runtimes" -B "$B" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_SYSTEM_NAME=Generic \
  -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
  -DCMAKE_C_COMPILER="$LLVM_BIN/clang" -DCMAKE_CXX_COMPILER="$LLVM_BIN/clang++" \
  -DCMAKE_AR="$LLVM_BIN/llvm-ar" -DCMAKE_RANLIB="$LLVM_BIN/llvm-ranlib" -DCMAKE_NM="$LLVM_BIN/llvm-nm" \
  -DCMAKE_C_FLAGS="$FLAGS" -DCMAKE_CXX_FLAGS="$FLAGS" \
  -DCMAKE_INSTALL_PREFIX="$SYSROOT" \
  -DLLVM_ENABLE_RUNTIMES="libcxx;libcxxabi" \
  -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_DOCS=OFF \
  -DLIBCXX_ENABLE_SHARED=OFF -DLIBCXX_ENABLE_STATIC=ON \
  -DLIBCXX_HERMETIC_STATIC_LIBRARY=ON -DLIBCXXABI_HERMETIC_STATIC_LIBRARY=ON \
  -DLIBCXX_HAS_MUSL_LIBC=ON \
  -DLIBCXX_HAS_PTHREAD_API=ON \
  -DLIBCXX_ENABLE_EXCEPTIONS=OFF \
  -DLIBCXX_CXX_ABI=libcxxabi \
  -DLIBCXX_ENABLE_STATIC_ABI_LIBRARY=ON \
  -DLIBCXX_USE_COMPILER_RT=ON \
  -DLIBCXX_INCLUDE_BENCHMARKS=OFF -DLIBCXX_INCLUDE_TESTS=OFF \
  -DLIBCXXABI_ENABLE_SHARED=OFF -DLIBCXXABI_ENABLE_STATIC=ON \
  -DLIBCXXABI_HAS_PTHREAD_API=ON \
  -DLIBCXXABI_ENABLE_EXCEPTIONS=OFF \
  -DLIBCXXABI_USE_LLVM_UNWINDER=OFF \
  -DLIBCXXABI_USE_COMPILER_RT=ON \
  -DLIBCXXABI_SILENT_TERMINATE=ON \
  -DLIBCXXABI_INCLUDE_TESTS=OFF \
  > "$BUILD_ROOT/libcxx-configure.log" 2>&1 || { tail -40 "$BUILD_ROOT/libcxx-configure.log"; exit 1; }
cmake --build "$B" -j "${LW_JOBS_MUSL_COMPILE:-4}" > "$BUILD_ROOT/libcxx-build.log" 2>&1 \
  || { grep -B2 -A12 -m3 "error:" "$BUILD_ROOT/libcxx-build.log" || tail -40 "$BUILD_ROOT/libcxx-build.log"; exit 1; }
cmake --install "$B" > "$BUILD_ROOT/libcxx-install.log" 2>&1 || { tail -20 "$BUILD_ROOT/libcxx-install.log"; exit 1; }
ls -l "$SYSROOT/lib/libc++.a" "$SYSROOT/include/c++/v1/vector"
