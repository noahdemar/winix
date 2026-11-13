/* setjmp/longjmp support for packages, via wasm exception handling.
 *
 * The guest libc's longjmp() aborts (wasm cannot unwind the stack by hand). Code compiled with
 * -mllvm -wasm-enable-sjlj instead has its setjmp/longjmp calls rewritten by LLVM (18) into calls to the
 * helpers below: setjmp records the call site in a per-function table, and longjmp throws a wasm exception
 * (tag __c_longjmp) that the setjmp-ing function catches and dispatches on. Linked into every package by
 * scripts/build-packages.sh. Each process has its own copy of this module's data. */
#include <stdint.h>
#include <stdlib.h>

struct entry {
	uintptr_t id;
	uint32_t label;
};

static uint32_t temp_ret0;
static uintptr_t setjmp_id;

void setTempRet0(uint32_t v)
{
	temp_ret0 = v;
}

uint32_t getTempRet0(void)
{
	return temp_ret0;
}

/* Called at each setjmp(env): gives env a fresh id and records (id, label) in the caller's table. */
struct entry *saveSetjmp(uintptr_t *env, uint32_t label, struct entry *table, uint32_t size)
{
	*env = ++setjmp_id;
	for (uint32_t i = 0; i < size; i++) {
		if (table[i].id == 0) {
			table[i].id = setjmp_id;
			table[i].label = label;
			table[i + 1].id = 0;
			setTempRet0(size);
			return table;
		}
	}
	size *= 2;
	table = realloc(table, sizeof(struct entry) * (size + 1));
	if (!table)
		abort();
	table[size / 2].id = 0;
	--setjmp_id;
	return saveSetjmp(env, label, table, size);
}

/* After catching a longjmp: the label of env's setjmp if it belongs to this function invocation, else 0. */
uint32_t testSetjmp(uintptr_t id, struct entry *table, uint32_t size)
{
	for (uint32_t i = 0; i < size && table[i].id; i++)
		if (table[i].id == id)
			return table[i].label;
	return 0;
}

struct longjmp_args {
	void *env;
	int val;
};
static struct longjmp_args longjmp_args;

void __wasm_longjmp(void *env, int val)
{
	longjmp_args.env = env;
	longjmp_args.val = val;
	__builtin_wasm_throw(1, &longjmp_args);
}
