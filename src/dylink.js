// Dynamic linker for winix guest processes: loads wasm shared objects into a running program (dlopen, dlsym).
//
// A guest program and a shared object have the same form: a position-independent wasm module (wasm-ld -shared, with
// a "dylink.0" section) that imports the machine's memory, a memory base for its data, the process's function table
// and a table base for its function pointers. The kernel places a program; this file places a shared object next to
// it, in memory the guest allocated (guest/dl.c), and binds its imports:
//
//   env.<function>     a function the object calls: the program's export of that name, or another object's (or
//                      its own, if it was not linked -Bsymbolic)
//   GOT.func.<name>    a global holding a function pointer (a table index) the object takes the address of
//   GOT.mem.<name>     a global holding the address of a data symbol
//   env.__memory_base, env.__table_base, env.__stack_pointer, env.memory, env.__indirect_function_table
//
// Symbols resolve in ELF order: the program, objects opened RTLD_GLOBAL, the object itself, then the objects it
// names as needed. A function pointer must be the same number wherever it is taken, so a function already in the
// table keeps its index and any other is appended once.
//
// One linker exists per process, in the Worker running it. A clone() child (a thread, or a vfork child before it
// execs) runs in a new Worker with a new table and its own instance of the program, so it replays the parent's
// operations (`onop` reports them; `replay` repeats them) to get the same objects at the same table indices,
// without running their relocations or constructors again.
//
// Classic script: defines globalThis.winixDylink. Loaded by linux-worker.js (patches/runtime) and by tests in Node.
(function (root) {
  'use strict';

  const decoder = new TextDecoder();

  /// Reads a shared object's dylink.0 section: its memory and table needs, the objects it needs, its weak imports.
  const parse = (bytes) => {
    let o = 8;
    const fail = (why) => { throw new Error('not a shared object (' + why + ')'); };
    const u = () => {
      let r = 0, shift = 0, b;
      do {
        if (o >= bytes.length) fail('truncated');
        b = bytes[o++];
        r += (b & 127) * 2 ** shift;
        shift += 7;
      } while (b & 128);
      return r;
    };
    const str = () => {
      const n = u();
      if (o + n > bytes.length) fail('truncated');
      const s = decoder.decode(bytes.slice(o, o + n));  // slice: decode() rejects views of shared memory
      o += n;
      return s;
    };
    if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) fail('no wasm header');
    if (bytes[o++] !== 0) fail('no dylink.0 section');
    const size = u(), end = o + size;
    if (end > bytes.length || str() !== 'dylink.0') fail('no dylink.0 section');
    const info = { memorySize: 0, memoryAlign: 1, tableSize: 0, needed: [], weak: [] };
    while (o < end) {
      const type = bytes[o++], length = u(), next = o + length;
      if (type === 1) {         // WASM_DYLINK_MEM_INFO; alignments are powers of two
        info.memorySize = u();
        info.memoryAlign = 2 ** u();
        info.tableSize = u();
      } else if (type === 2) {  // WASM_DYLINK_NEEDED
        for (let n = u(); n--;) info.needed.push(str());
      } else if (type === 4) {  // WASM_DYLINK_IMPORT_INFO: (module, field, flags); bit 0 is weak binding
        for (let n = u(); n--;) {
          str();
          const field = str();
          if (u() & 1) info.weak.push(field);
        }
      }
      o = next;
    }
    return info;
  };

  /// A linker for one process. `main` is the program's instance, `mainBase` its memory base, `env` the "env" imports
  /// it was given (host functions, __stack_pointer and the longjmp tag are handed on to shared objects from there).
  const create = ({ memory, table, main, mainBase, env, bits = 32, onop = null }) => {
    const ptr = bits === 32 ? Number : BigInt;
    const ptrType = 'i' + bits;
    const mainScope = { exports: main.exports, base: mainBase };
    const libs = [];      // handle - 1 -> { module, base, tableBase, global, deps, exports }
    let fnIndex = null;   // function -> table index, for every function in the table
    let appended = 0;
    let replaying = false;

    const emit = (op) => { if (onop && !replaying) onop(op); };

    const scan = (from, to) => {
      for (let i = from; i < to; i++) {
        const f = table.get(i);
        if (f !== null && !fnIndex.has(f)) fnIndex.set(f, i);
      }
    };

    /// The function pointer for f: its index if it is in the table, else a new slot.
    const pointerOf = (f) => {
      if (!fnIndex) {
        fnIndex = new Map();
        scan(0, table.length);
      }
      let i = fnIndex.get(f);
      if (i === undefined) {
        i = table.grow(1);
        table.set(i, f);
        fnIndex.set(f, i);
        appended++;
      }
      return i;
    };

    const find = (scopes, name, isFunction) => {
      for (const scope of scopes) {
        const e = scope.exports[name];
        if (isFunction ? typeof e === 'function' : e instanceof WebAssembly.Global) return [scope, e];
      }
      return null;
    };

    const addressOf = ([scope, e], isFunction) => isFunction ? pointerOf(e) : Number(e.value) + scope.base;

    /// Places a compiled object at memBase and binds it. Changes nothing if a symbol is missing.
    const link = (module, info, memBase, global, deps) => {
      const lib = { module, base: memBase, tableBase: table.length, global, deps, exports: Object.create(null) };
      const globals = libs.filter((l) => l.global);
      const outer = [mainScope, ...globals, ...deps];
      const declared = new Map(WebAssembly.Module.exports(module).map((e) => [e.name, e.kind]));
      const weak = new Set(info.weak);
      const imports = {}, got = [], missing = [];

      for (const imp of WebAssembly.Module.imports(module)) {
        let value;
        if (imp.module === 'GOT.func' || imp.module === 'GOT.mem') {
          // Filled in after instantiation, when the object's own exports exist; nothing reads them before then.
          const isFunction = imp.module === 'GOT.func';
          value = new WebAssembly.Global({ value: ptrType, mutable: true }, ptr(0));
          got.push({ isFunction, name: imp.name, global: value });
          if (!find(outer, imp.name, isFunction) && declared.get(imp.name) !== (isFunction ? 'function' : 'global')
              && !weak.has(imp.name)) missing.push(imp.name);
        } else if (imp.module === 'env' && imp.kind === 'function') {
          const hit = find(outer, imp.name, true);
          if (hit) value = hit[1];
          // A function of its own that the object calls through an import, because another module could have
          // defined it first (weak, or default visibility without -Bsymbolic): its own export, once that exists.
          else if (declared.get(imp.name) === 'function') value = (...args) => lib.exports[imp.name](...args);
          else if (typeof env[imp.name] === 'function') value = env[imp.name];
          if (!value && weak.has(imp.name)) {
            value = () => { throw new WebAssembly.RuntimeError('call to undefined weak symbol ' + imp.name); };
          }
          if (!value) missing.push(imp.name);
        } else if (imp.module === 'env') {
          if (imp.kind === 'memory') value = memory;
          else if (imp.kind === 'table') value = table;
          else if (imp.name === '__memory_base') value = new WebAssembly.Global({ value: ptrType }, ptr(memBase));
          else if (imp.name === '__table_base') value = new WebAssembly.Global({ value: ptrType }, ptr(lib.tableBase));
          else if (imp.name === '__table_base32') value = new WebAssembly.Global({ value: 'i32' }, lib.tableBase);
          else value = env[imp.name];  // __stack_pointer and the longjmp tag are the program's own
          if (value === undefined) missing.push(imp.name);
        } else {
          missing.push(imp.module + '.' + imp.name);
        }
        (imports[imp.module] ||= {})[imp.name] = value;
      }
      if (missing.length) {
        throw new Error('symbol not found: ' + missing.slice(0, 8).join(', ') + (missing.length > 8 ? ', ...' : ''));
      }

      if (info.tableSize) table.grow(info.tableSize);
      // Instantiation runs the object's start function, which copies its data to memBase (once: a flag in that
      // data makes later instantiations, in clone() children, skip it).
      lib.exports = new WebAssembly.Instance(module, imports).exports;
      if (fnIndex) scan(lib.tableBase, lib.tableBase + info.tableSize);

      const inner = [mainScope, ...globals, lib, ...deps];
      for (const entry of got) {
        const hit = find(inner, entry.name, entry.isFunction);
        if (hit) entry.global.value = ptr(addressOf(hit, entry.isFunction));  // else weak and undefined: stays 0
      }
      libs.push(lib);
      return libs.length;
    };

    const linkLogged = (op) => {
      const before = table.length;
      try {
        return link(op.module, op, op.memBase, op.global, op.deps.map((h) => libs[h - 1]));
      } catch (error) {
        // A failure after the table grew (the module did not instantiate) still moved later objects' indices.
        if (table.length !== before) emit({ t: 'pad', n: table.length - before });
        throw error;
      }
    };

    const dl = {
      /// Links a shared object placed at memBase (memory the caller allocated and zeroed, of the size and alignment
      /// parse() gives). `deps` are the handles of the objects it needs. Returns its handle, or throws an Error whose
      /// message says why. Call init(handle) next.
      open(bytes, memBase, global = false, deps = []) {
        const info = parse(bytes);
        for (const h of deps) if (!libs[h - 1]) throw new Error('invalid library handle');
        const op = { t: 'lib', module: new WebAssembly.Module(bytes), memBase, global, deps, tableSize: info.tableSize, weak: info.weak };
        const handle = linkLogged(op);
        emit(op);
        return handle;
      },

      /// Runs a newly opened object's data relocations and constructors. Guest code: exceptions pass through.
      init(handle) {
        const { exports } = libs[handle - 1];
        if (exports.__wasm_apply_data_relocs) exports.__wasm_apply_data_relocs();
        if (exports.__wasm_call_ctors) exports.__wasm_call_ctors();
      },

      /// The address of a symbol (for a function, its function pointer), or undefined. Handle 0 searches the program
      /// and the objects opened RTLD_GLOBAL; another handle searches that object and the objects it needs.
      sym(handle, name) {
        const lib = libs[handle - 1];
        const scopes = handle === 0 ? [mainScope, ...libs.filter((l) => l.global)] : lib ? [lib, ...lib.deps] : [];
        for (const isFunction of [true, false]) {
          const hit = find(scopes, name, isFunction);
          if (!hit) continue;
          const before = appended;
          const address = addressOf(hit, isFunction);
          if (appended !== before) emit({ t: 'sym', handle, name });
          return address;
        }
        return undefined;
      },

      /// In a clone() child: repeats the operations reported through onop, in order.
      replay(ops) {
        replaying = true;
        try {
          for (const op of ops) {
            if (op.t === 'lib') linkLogged(op);
            else if (op.t === 'pad') table.grow(op.n);
            else if (op.t === 'sym') dl.sym(op.handle, op.name);
          }
        } finally {
          replaying = false;
        }
      },

      get count() { return libs.length; },
    };
    return dl;
  };

  root.winixDylink = { parse, create };
})(globalThis);
