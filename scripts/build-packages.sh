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
# setjmp/longjmp become wasm exceptions (the libc's longjmp aborts); guest/sjlj.c has the runtime helpers.
CFLAGS=(--target=wasm-linux-musl -march="${LW_VARIANT%%_*}" "--sysroot=$I/musl-$LW_VARIANT" -fPIC -D__linux__
  --rtlib=compiler-rt -O2 -mexception-handling -mllvm -wasm-enable-sjlj)
mkdir -p "$OUT" "$WORK" "$DL"
SJLJ="$WORK/sjlj.o"
"$CC" "${CFLAGS[@]}" -c "$REPO/guest/sjlj.c" -o "$SJLJ"
# dlopen/dlsym (guest/dl.c). A program that loads shared objects adds "$LIBDL" to its link, and "${WHOLE_LIBC[@]}"
# so that the objects, which have no libc of their own, find all of it among the program's exports.
LIBDL="$WORK/dl.o"
"$CC" "${CFLAGS[@]}" -c "$REPO/guest/dl.c" -o "$LIBDL"
# What C++ code calls to throw (guest/cxa.c), linked in by the c++ wrapper below.
CXA="$WORK/cxa.o"
"$CC" "${CFLAGS[@]}" -c "$REPO/guest/cxa.c" -o "$CXA"
WHOLE_LIBC=(-Wl,--whole-archive -lc -Wl,--no-whole-archive)
WHOLE_LIBC_FLAGS="${WHOLE_LIBC[*]}"

# fetch URL SHA256 FILE [MIRROR]: download once into $DL (from MIRROR if URL fails), verify, copy to FILE. An empty
# SHA256 prints the hash to pin.
fetch() {
  local cache="$DL/$NAME-$(basename "$1")"
  # A failed download must stop the build here, not surface later as a missing or truncated file.
  if [ ! -f "$cache" ]; then
    curl -fsSL --retry 3 --retry-all-errors -o "$cache.part" "$1" \
      || { [ -n "${4:-}" ] && curl -fsSL --retry 3 --retry-all-errors -o "$cache.part" "$4"; } \
      || { echo "$NAME: cannot download $1"; exit 1; }
    mv "$cache.part" "$cache"
  fi
  local got
  got=$(sha256sum "$cache" | cut -d ' ' -f 1)
  if [ -z "$2" ]; then echo "  $NAME: pin SHA256=$got"; elif [ "$got" != "$2" ]; then echo "$NAME: hash mismatch for $1"; exit 1; fi
  cp "$cache" "$3"
}
cc_compile() { "$CC" "${CFLAGS[@]}" "$@"; }
# The fake-llvm wrapper only treats a command as a link when it sees a -l flag.
cc_link() { "$CC" "${CFLAGS[@]}" "-m${LW_VARIANT%%_*}" -shared "$SJLJ" "$@" -lc; }
# cc_link_so OBJECTS... -o FILE: link a shared object for dlopen(). It is position-independent like a program, but
# imports every symbol it does not define from the program that loads it (so no -lc), and exports only symbols with
# default visibility: clang hides symbols by default on wasm, so mark the interface, or compile with
# -fvisibility=default. Its references to its own symbols are bound at link time (-Bsymbolic), so a library linked
# in statically (libc++, say) stays private to it. A shared object named among the inputs is recorded as needed.
case "$LW_VARIANT" in wasm32*) SO_MAX_MEMORY=4294967296 ;; *) SO_MAX_MEMORY=17179869184 ;; esac
BUILTINS="$("$REAL_LLVM/clang" "--target=${LW_VARIANT%%_*}-unknown-unknown" --rtlib=compiler-rt -print-libgcc-file-name 2>/dev/null || true)"
[ -f "$BUILTINS" ] || BUILTINS=
cc_link_so() {
  "$REAL_LLVM/wasm-ld" "-m${LW_VARIANT%%_*}" -shared -Bsymbolic --experimental-pic --no-entry --import-memory --shared-memory \
    "--max-memory=$SO_MAX_MEMORY" --import-table --unresolved-symbols=import-dynamic \
    --export-if-defined=__wasm_call_ctors "$@" $BUILTINS
}
# set_stack_size FILE BYTES: ask the kernel for a larger stack than the default 256 KiB (patches/kernel/0006), with
# a "winix.stack_size" custom section. Append it after stripping, which would drop the section.
set_stack_size() {
  python3 - "$1" "$2" <<'PY'
import sys
def leb(n):
    out = bytearray()
    while True:
        b, n = n & 0x7F, n >> 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)
name = b"winix.stack_size"
body = leb(len(name)) + name + int(sys.argv[2]).to_bytes(4, "little")
with open(sys.argv[1], "ab") as f:
    f.write(b"\x00" + leb(len(body)) + body)
PY
}
export -f fetch cc_compile cc_link cc_link_so set_stack_size
export CC LW_VARIANT DL SJLJ LIBDL WHOLE_LIBC_FLAGS SO_MAX_MEMORY BUILTINS

# Plain `cc` and `c++` on PATH for configure/make/meson builds. Each compiles; or links a guest program (the sjlj
# helpers and the libc go in, and the C++ library for c++); or, given -shared, links a shared object for dlopen()
# with cc_link_so's flags (the build system's own linker flags are for ELF: only inputs, -L, -l, -o and a few
# wasm-ld understands are kept, and the libc's libraries are dropped, since the program that loads it has them).
# c++ needs the C++ library in the sysroot (scripts/build.sh libcxx).
mkdir -p "$WORK/bin"
SYSROOT="$I/musl-$LW_VARIANT"
CXXFLAGS=("--target=${LW_VARIANT%%_*}-unknown-unknown" "--sysroot=$SYSROOT" -fPIC -D__linux__ -D__unix__ -D__unix
  -Xclang -target-feature -Xclang +atomics -Xclang -target-feature -Xclang +bulk-memory -O2 -mexception-handling
  -mllvm -wasm-enable-sjlj)
cat > "$WORK/bin/link-so" <<LINK
#!/bin/bash
# link-so EXTRA-LIBRARY... -- DRIVER-ARGS...: see build-packages.sh.
extra=()
while [ "\$1" != -- ]; do extra+=("\$1"); shift; done
shift
args=()
while [ \$# -gt 0 ]; do
  a=\$1; shift
  case \$a in
    -o) args+=(-o "\$1"); shift ;;
    -L*|*.o|*.a|*.so|*.so.*) args+=("\$a") ;;
    -lc|-lm|-lpthread|-ldl|-lrt|-lutil|-lc++|-lc++abi|-lstdc++) ;;
    -l*) args+=("\$a") ;;
    -Wl,*)
      IFS=, read -ra parts <<< "\${a#-Wl,}"
      for x in "\${parts[@]}"; do
        case \$x in --whole-archive|--no-whole-archive|--export=*|--export-if-defined=*) args+=("\$x") ;; esac
      done ;;
  esac
done
exec "$REAL_LLVM/wasm-ld" -m${LW_VARIANT%%_*} -shared -Bsymbolic --experimental-pic --no-entry --import-memory --shared-memory \\
  --max-memory=$SO_MAX_MEMORY --import-table --unresolved-symbols=import-dynamic \\
  --export-if-defined=__wasm_call_ctors "\${args[@]}" "\${extra[@]}" $BUILTINS
LINK
# A program link accepts undefined functions (they become imports), so a build system's "does this function link?"
# probe always says yes. With WINIX_STRICT_LINK=1 in the environment (meson builds set it), a program that imports
# anything the runtime does not supply fails to link, as it would on other systems.
cat > "$WORK/bin/link-program" <<LINK
#!/bin/bash
"$CC" ${CFLAGS[*]} -m${LW_VARIANT%%_*} -shared "$SJLJ" "\$@" -lc || exit
[ -n "\$WINIX_STRICT_LINK" ] || exit 0
out=a.out
while [ \$# -gt 0 ]; do [ "\$1" = -o ] && out=\$2; shift; done
[ ! -f "\$out" ] || python3 "$REPO/scripts/wasm-syms.py" check-probe "\$out"
LINK
# (Compiling, --rtlib is unused, which a build system probing with -Werror=unused-command-line-argument trips on.)
COMPILE_FLAGS=("${CFLAGS[@]/--rtlib=compiler-rt/}")
cat > "$WORK/bin/cc" <<CC
#!/bin/bash
for a; do case \$a in -c|-E|-S|-M|-MM) exec "$CC" ${COMPILE_FLAGS[*]} "\$@" ;; esac; done
for a; do case \$a in -shared) exec "$WORK/bin/link-so" -- "\$@" ;; esac; done
exec "$WORK/bin/link-program" "\$@"
CC
cat > "$WORK/bin/c++" <<CXX
#!/bin/bash
for a; do case \$a in -c|-E|-S|-M|-MM) exec "$REAL_LLVM/clang++" ${CXXFLAGS[*]} "\$@" ;; esac; done
for a; do case \$a in -shared) exec "$WORK/bin/link-so" "$SYSROOT/lib/libc++.a" "$CXA" -- "\$@" ;; esac; done
exec "$WORK/bin/link-program" "\$@" "$SYSROOT/lib/libc++.a" "$CXA"
CXX
chmod +x "$WORK/bin/cc" "$WORK/bin/c++" "$WORK/bin/link-so" "$WORK/bin/link-program"
ln -sf cc "$WORK/bin/gcc"
ln -sf c++ "$WORK/bin/g++"
for t in ar ranlib nm strip; do ln -sf "$I/llvm/bin/llvm-$t" "$WORK/bin/$t"; done
export PATH="$WORK/bin:$PATH" WASM_CC="$WORK/bin/cc"

recipes=()
# With no names, every recipe except those marked EXPERIMENTAL=1 (built and published only when named).
if [ $# -gt 0 ]; then
  for n; do recipes+=("$REPO/packages/$n.sh"); done
else
  # (A recipe sets NAME; packages/ also holds helper scripts, which must not be sourced as recipes.)
  for r in "$REPO"/packages/*.sh; do
    grep -q '^NAME=' "$r" && ! grep -q '^EXPERIMENTAL=1' "$r" && recipes+=("$r")
  done
fi

# Dependencies first: a recipe may use what its DEPS' builds left behind (numpy needs python's build tree).
ordered=()
order() {
  local r=$1 d deps
  case " ${ordered[*]-} " in *" $r "*) return ;; esac
  deps=$(sed -n 's/^DEPS=//p' "$r" | tr -d '"')
  for d in $deps; do
    [ "$d" = - ] || [ ! -f "$REPO/packages/$d.sh" ] || case " ${recipes[*]} " in *" $REPO/packages/$d.sh "*) order "$REPO/packages/$d.sh" ;; esac
  done
  ordered+=("$r")
}
for r in "${recipes[@]}"; do order "$r"; done

for r in "${ordered[@]}"; do
  (
    source "$r"
    B="$WORK/$NAME"
    export DEST="$B/root" NAME
    rm -rf "$B" && mkdir -p "$DEST" && cd "$B"
    echo "building $NAME $VERSION"
    build > "$B/build.log" 2>&1 || { tail -30 "$B/build.log"; exit 1; }
    grep -h "pin SHA256" "$B/build.log" || true
    # Archives are named by content (name_version_<sha256 prefix>), so browsers can cache them forever.
    rm -f "$OUT/${NAME}_"*.tar.gz
    tar czf "$B/pkg.tar.gz" --owner=0 --group=0 -C "$DEST" .
    sum=$(sha256sum "$B/pkg.tar.gz" | cut -d ' ' -f 1)
    mv "$B/pkg.tar.gz" "$OUT/${NAME}_${VERSION}_${sum:0:12}.tar.gz"
    echo "$NAME $VERSION $sum $(stat -c %s "$OUT/${NAME}_${VERSION}_${sum:0:12}.tar.gz") $DEPS $DESC" > "$WORK/$NAME.entry"
  )
done

cat "$WORK"/*.entry | sort > "$OUT/index.txt"
cat "$OUT/index.txt"
