// Dynamic linker (src/dylink.js) against real position-independent modules, in Node: no browser, no kernel.
// Builds tests/fixtures/dylink/*.c with the flags guest programs are built with (see fake-llvm's wrapper), then
// plays the runtime's part: a shared memory, a function table per process, a program instance.
// Usage: node tests/dylink.mjs      (WINIX_LLVM=<dir with clang and wasm-ld>; default: winix's own, or Emscripten's)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageChannel } from 'node:worker_threads';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(repo, 'tests/fixtures/dylink');
const out = join(repo, 'build/dylink');
mkdirSync(out, { recursive: true });

const llvm = [process.env.WINIX_LLVM, join(homedir(), 'winix-build/workspace/install/llvm/bin'),
  '/opt/homebrew/opt/emscripten/libexec/llvm/bin', '/usr/local/opt/emscripten/libexec/llvm/bin', '/usr/lib/emscripten/llvm/bin']
  .find((d) => d && existsSync(join(d, 'wasm-ld')));
if (!llvm) {
  console.error('no clang/wasm-ld found: set WINIX_LLVM to an LLVM bin directory with the WebAssembly target');
  process.exit(2);
}

// -fvisibility=default (clang's wasm default is hidden): an object's references to its own symbols then go through
// the GOT, the harder case; an object built with hidden visibility has only its imports from elsewhere to bind.
const CFLAGS = ['--target=wasm32-unknown-unknown', '-fPIC', '-O1', '-nostdlib', '-fvisibility=default', '-Xclang', '-target-feature',
  '-Xclang', '+atomics', '-Xclang', '-target-feature', '-Xclang', '+bulk-memory'];
const LDFLAGS = ['-shared', '--experimental-pic', '--no-entry', '--import-memory', '--shared-memory', '--max-memory=4294967296',
  '--import-table', '--unresolved-symbols=import-dynamic', '--export-if-defined=__wasm_call_ctors'];
// A program: everything exported and kept, its own symbols bound directly (-Bsymbolic), as packages/python.sh links.
const PROGRAM = ['-no-gc-sections', '--no-merge-data-segments', '--export-all', '-Bsymbolic'];
const build = (name, extra = [], inputs = []) => {
  execFileSync(join(llvm, 'clang'), [...CFLAGS, '-c', join(src, name + '.c'), '-o', join(out, name + '.o')], { stdio: 'inherit' });
  const file = join(out, name === 'main' ? 'main.wasm' : name + '.so');
  // Run in the output directory so a needed library is recorded by its file name.
  execFileSync(join(llvm, 'wasm-ld'), [...LDFLAGS, ...extra, name + '.o', ...inputs, '-o', file], { cwd: out, stdio: 'inherit' });
  return new Uint8Array(readFileSync(file));
};
const bytes = { main: build('main', PROGRAM) };
for (const name of ['a', 'c', 'd1', 'd2']) bytes[name] = build(name);
bytes.b = build('b', [], ['a.so']);

await import(join(repo, 'src/dylink.js'));
const { parse, create } = globalThis.winixDylink;

// The machine: one shared memory. Addresses are handed out by a bump allocator standing in for the kernel and malloc.
const memory = new WebAssembly.Memory({ initial: 64, maximum: 65536, shared: true });
let brk = 65536;
const alloc = (size, align = 16) => {
  const at = Math.ceil(brk / align) * align;
  brk = at + size;
  return at;
};
const i32 = (address) => new Int32Array(memory.buffer)[address >> 2];

const mainModule = new WebAssembly.Module(bytes.main);
const mainInfo = parse(bytes.main);
const dataStart = alloc(mainInfo.memorySize, mainInfo.memoryAlign);
const stackPointer = alloc(65536) + 65536;

/// What linux-worker.js does for a task: a fresh table and program instance over the shared memory. A clone() child
/// gets the same image at the same address and must not relocate it again.
const startTask = ({ clone = false, ops = null } = {}) => {
  const table = new WebAssembly.Table({ initial: 64, element: 'anyfunc' });
  const env = {
    memory,
    __memory_base: new WebAssembly.Global({ value: 'i32' }, dataStart),
    __stack_pointer: new WebAssembly.Global({ value: 'i32', mutable: true }, stackPointer),
    __indirect_function_table: table,
    __table_base: new WebAssembly.Global({ value: 'i32' }, 0),
  };
  const main = new WebAssembly.Instance(mainModule, { env });
  if (!clone) main.exports.__wasm_apply_data_relocs();
  const log = [];
  const dl = create({ memory, table, main, mainBase: dataStart, env, onop: (op) => log.push(op) });
  if (ops) dl.replay(ops);
  return { table, main: main.exports, dl, log };
};

/// What guest/dl.c does: allocate zeroed memory for the object, link it, run its relocations and constructors.
const dlopen = (task, name, { global = false, deps = [] } = {}) => {
  const info = parse(bytes[name]);
  const base = alloc(info.memorySize, Math.max(info.memoryAlign, 16));
  const handle = task.dl.open(bytes[name], base, global, deps);
  task.dl.init(handle);
  return handle;
};

let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log('ok ' + name);
};

const parent = startTask();
const { main, dl } = parent;
let a, b;

test('dylink.0 is parsed', () => {
  assert.ok(mainInfo.memorySize > 0 && mainInfo.tableSize > 0);
  assert.deepEqual(parse(bytes.b).needed, ['a.so']);
  assert.ok(parse(bytes.a).weak.includes('missing_weak'));
  assert.throws(() => parse(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 0])), /not a shared object/);
});

test('an object binds to the program: calls, data, function pointers', () => {
  a = dlopen(parent, 'a');
  const call = (name) => main.main_call0(dl.sym(a, name));
  assert.equal(call('a_ctor_value'), 8);   // the constructor ran, after relocations (it read main_counter through one)
  assert.equal(call('a_sum'), 100 + 7 + 3 + 10 + 9);
  assert.equal(call('a_weak_is_null'), 1);
  assert.equal(main.main_call1(dl.sym(a, 'a_calls_hook'), 1), 2);  // its own weak function, reached through an import
});

test('a function has one pointer value everywhere', () => {
  // main_add was in the program's table already: the object must get that index, not a second one.
  assert.equal(main.main_call0(dl.sym(a, 'a_same_pointer')), 1);
  assert.equal(dl.sym(0, 'main_add'), i32(dl.sym(0, 'main_fp')));
  // main_twice was not: the object's GOT entry put it there, and dlsym finds the same slot.
  assert.equal(dl.sym(0, 'main_twice'), i32(dl.sym(a, 'a_fn_twice')));
  assert.equal(main.main_call1(dl.sym(0, 'main_twice'), 21), 42);
  // The object's own functions, exported or static, are callable from the program through the table.
  assert.equal(main.main_call1(dl.sym(a, 'a_square'), 9), 81);
  assert.equal(dl.sym(a, 'a_square'), i32(dl.sym(a, 'a_fn_square')));
  assert.equal(main.main_call1(main.main_call0(dl.sym(a, 'a_get_static')), 1), 1001);
});

test('dlsym returns data addresses, and nothing for unknown names', () => {
  assert.equal(main.main_load(dl.sym(a, 'a_data')), 100);
  assert.equal(main.main_load(dl.sym(0, 'main_counter')), 7);
  assert.equal(dl.sym(a, 'no_such_symbol'), undefined);
  assert.equal(dl.sym(a, 'main_counter'), undefined);  // a handle searches that object, not the program
  assert.equal(dl.sym(0, 'a_data'), undefined);         // a was not opened RTLD_GLOBAL
  assert.equal(dl.sym(99, 'a_data'), undefined);
});

test('a missing symbol fails the load and changes nothing', () => {
  const before = parent.table.length, ops = parent.log.length;
  assert.throws(() => dlopen(parent, 'c'), /symbol not found: nowhere/);
  assert.equal(parent.table.length, before);
  assert.equal(parent.log.length, ops);
  assert.equal(dl.count, 1);
});

test('an object resolves symbols in the objects it needs', () => {
  assert.throws(() => dlopen(parent, 'b'), /symbol not found: a_sum/);  // a is not global: b must name it
  b = dlopen(parent, 'b', { deps: [a] });
  assert.equal(main.main_call0(dl.sym(b, 'b_sum')), 129 + 100);
  assert.equal(main.main_load(dl.sym(b, 'a_data')), 100);  // dlsym on b also searches what b needs
});

test('objects opened locally keep their own symbols; RTLD_GLOBAL ones are seen first', () => {
  const d1 = dlopen(parent, 'd1'), d2 = dlopen(parent, 'd2');
  const get = (h) => main.main_load(main.main_call0(dl.sym(h, 'd_get')));
  assert.equal(get(d1), 1);
  assert.equal(get(d2), 2);
  const g1 = dlopen(parent, 'd1', { global: true });   // a second copy, as if another file
  const d2b = dlopen(parent, 'd2');
  assert.equal(get(g1), 1);
  assert.equal(get(d2b), 1);                            // d2's reference to shared_name now binds to the global d1
  assert.equal(main.main_load(dl.sym(0, 'shared_name')), 1);
});

test('a clone() child replays to the same table', () => {
  // The log crosses threads through the main thread: it must survive structured cloning (it holds Modules).
  const { port1, port2 } = new MessageChannel();
  port1.postMessage(parent.log);
  port1.close();
  port2.close();
  const child = startTask({ clone: true, ops: parent.log });
  assert.equal(child.table.length, parent.table.length);
  assert.equal(child.log.length, 0);
  // Function pointers the parent stored in shared memory mean the same functions in the child.
  const names = (t) => Array.from({ length: t.table.length }, (_, i) => t.table.get(i)?.name ?? null);
  assert.deepEqual(names(child), names(parent));
  const call = (name) => child.main.main_call0(child.dl.sym(a, name));
  assert.equal(call('a_sum'), 129);       // through a_fn_twice and a_fn_square, pointers the parent's relocations wrote
  assert.equal(call('a_ctor_value'), 8);  // the parent's value: the constructor did not run again
  assert.equal(child.main.main_call0(child.dl.sym(b, 'b_sum')), 229);
  assert.equal(child.dl.sym(0, 'main_twice'), dl.sym(0, 'main_twice'));
});

test('a slot dlsym adds is replayed too', () => {
  const task = startTask();
  const h = dlopen(task, 'd1');
  const fp = task.dl.sym(h, 'd_get');     // exported, never address-taken: gets a slot now
  const later = dlopen(task, 'a');         // and a later object lands after it
  assert.deepEqual(task.log.map((op) => op.t), ['lib', 'sym', 'lib']);
  const child = startTask({ clone: true, ops: task.log });
  assert.equal(child.table.length, task.table.length);
  assert.equal(child.dl.sym(h, 'd_get'), fp);
  assert.equal(child.main.main_call0(child.dl.sym(later, 'a_sum')), 129);
});

console.log(`${passed} passed`);
