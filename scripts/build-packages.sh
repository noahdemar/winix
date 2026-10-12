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

# fetch URL SHA256 FILE: download once into $DL, verify, copy to FILE. An empty SHA256 prints the hash to pin.
fetch() {
  local cache="$DL/$NAME-$(basename "$1")"
  [ -f "$cache" ] || curl -fsSL -o "$cache" "$1"
  local got
  got=$(sha256sum "$cache" | cut -d ' ' -f 1)
  if [ -z "$2" ]; then echo "  $NAME: pin SHA256=$got"; elif [ "$got" != "$2" ]; then echo "$NAME: hash mismatch for $1"; exit 1; fi
  cp "$cache" "$3"
}
cc_compile() { "$CC" "${CFLAGS[@]}" "$@"; }
# The fake-llvm wrapper only treats a command as a link when it sees a -l flag.
cc_link() { "$CC" "${CFLAGS[@]}" "-m${LW_VARIANT%%_*}" -shared "$SJLJ" "$@" -lc; }
export -f fetch cc_compile cc_link
export CC LW_VARIANT DL SJLJ

# A plain `cc` on PATH for configure/make builds: compiles, or links a guest program (-shared, sjlj helpers, libc).
mkdir -p "$WORK/bin"
cat > "$WORK/bin/cc" <<CC
#!/bin/bash
for a; do case \$a in -c|-E|-S|-M|-MM) exec "$CC" ${CFLAGS[*]} "\$@" ;; esac; done
exec "$CC" ${CFLAGS[*]} -m${LW_VARIANT%%_*} -shared "$SJLJ" "\$@" -lc
CC
chmod +x "$WORK/bin/cc"
ln -sf cc "$WORK/bin/gcc"
for t in ar ranlib nm strip; do ln -sf "$I/llvm/bin/llvm-$t" "$WORK/bin/$t"; done
export PATH="$WORK/bin:$PATH" WASM_CC="$WORK/bin/cc"

recipes=()
# With no names, every recipe except those marked EXPERIMENTAL=1 (built and published only when named).
if [ $# -gt 0 ]; then
  for n; do recipes+=("$REPO/packages/$n.sh"); done
else
  for r in "$REPO"/packages/*.sh; do grep -q '^EXPERIMENTAL=1' "$r" || recipes+=("$r"); done
fi

for r in "${recipes[@]}"; do
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
