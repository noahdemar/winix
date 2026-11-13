#!/usr/bin/env python3
"""List what a wasm module imports or exports, one name per line, for build-time link checks.

Guest links accept undefined symbols (they become imports the runtime is expected to supply), so a function the libc
lacks only shows up when the program fails to start, or a shared object fails to load. These listings let a build
check instead.

Usage: wasm-syms.py imports|exports FILE          (functions, GOT entries and data symbols; not memories or tables)
       wasm-syms.py check-program FILE            (fails, naming them, if FILE imports functions the runtime lacks)
       wasm-syms.py check-probe FILE              (the same, for a build system's link test)
       wasm-syms.py check-so PROGRAM FILE...      (fails if a shared object imports what PROGRAM does not export)
"""
import sys

# What linux-worker.js gives every program ("env"), apart from memory, table and globals.
RUNTIME = ("__wasm_syscall_", "__wasm_abort", "__winix_dl_", "winix_jit_")


def sections(data):
    assert data[:4] == b"\0asm", "not a wasm module"
    pos = 8
    while pos < len(data):
        kind = data[pos]
        size, pos = leb(data, pos + 1)
        yield kind, pos, pos + size
        pos += size


def leb(data, pos):
    result = shift = 0
    while True:
        byte = data[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        shift += 7
        if not byte & 0x80:
            return result, pos


def name(data, pos):
    size, pos = leb(data, pos)
    return data[pos:pos + size].decode(), pos + size


def imports(data):
    """(module, field, kind) for each import; kind 0 function, 1 table, 2 memory, 3 global, 4 tag."""
    for kind, pos, end in sections(data):
        if kind != 2:
            continue
        count, pos = leb(data, pos)
        for _ in range(count):
            module, pos = name(data, pos)
            field, pos = name(data, pos)
            what = data[pos]
            pos += 1
            if what == 0:
                _, pos = leb(data, pos)
            elif what == 1:
                pos += 1
                flags, pos = leb(data, pos)
                _, pos = leb(data, pos)
                if flags & 1:
                    _, pos = leb(data, pos)
            elif what == 2:
                flags, pos = leb(data, pos)
                _, pos = leb(data, pos)
                if flags & 1:
                    _, pos = leb(data, pos)
            elif what == 3:
                pos += 2
            elif what == 4:
                pos += 1
                _, pos = leb(data, pos)
            yield module, field, what


def exports(data):
    for kind, pos, end in sections(data):
        if kind != 7:
            continue
        count, pos = leb(data, pos)
        for _ in range(count):
            field, pos = name(data, pos)
            what = data[pos]
            _, pos = leb(data, pos + 1)
            if what in (0, 3):
                yield field


def symbol_imports(data):
    """Names a module needs from elsewhere: functions it calls and the GOT entries of functions and data."""
    for module, field, what in imports(data):
        if what == 0 or module.startswith("GOT."):
            yield field


def main(argv):
    mode, files = argv[1], argv[2:]
    read = lambda path: open(path, "rb").read()
    if mode == "imports":
        print("\n".join(symbol_imports(read(files[0]))))
    elif mode == "exports":
        print("\n".join(exports(read(files[0]))))
    elif mode in ("check-program", "check-probe"):
        # A configure-style probe is only linked, never run, and is often written as `int main(void)`, which this
        # toolchain's startup code does not link to (it leaves __main_argc_argv undefined): tolerated in a probe.
        allowed = RUNTIME + (("__main_argc_argv",) if mode == "check-probe" else ())
        missing = [f for f in symbol_imports(read(files[0])) if not f.startswith(allowed)]
        if missing:
            sys.exit("%s: undefined symbols: %s" % (files[0], " ".join(missing)))
    elif mode == "check-so":
        have = set(exports(read(files[0])))
        bad = 0
        for path in files[1:]:
            data = read(path)
            own = set(exports(data))
            missing = sorted(set(f for f in symbol_imports(data) if f not in have and f not in own))
            if missing:
                bad = 1
                print("%s: not exported by %s: %s" % (path, files[0], " ".join(missing)), file=sys.stderr)
        sys.exit(bad)
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv)
