/* A shared object that uses every kind of import the linker binds. */
extern int main_counter;
int main_add(int, int);
int main_twice(int);
int (*main_get_fp(void))(int, int);
int missing_weak(int) __attribute__((weak));

int a_data = 100;
int *a_data_ptr = &a_data;            /* GOT.mem, to itself */
int *a_main_ptr = &main_counter;      /* GOT.mem, to the program */
int (*a_fn_add)(int, int) = main_add; /* GOT.func: already in the program's table */
int (*a_fn_twice)(int) = main_twice;  /* GOT.func: not in the table yet */
int a_square(int x) { return x * x; }
int (*a_fn_square)(int) = a_square;   /* GOT.func, to itself */

static int ctor_value;
__attribute__((constructor)) static void a_ctor(void) { ctor_value = *a_main_ptr + 1; } /* needs relocations first */
int a_ctor_value(void) { return ctor_value; }

int a_sum(void) { return *a_data_ptr + *a_main_ptr + main_add(1, 2) + a_fn_twice(5) + a_fn_square(3); }
int a_same_pointer(void) { return a_fn_add == main_get_fp(); }
int a_weak_is_null(void) { return missing_weak == 0; }

static int a_static(int x) { return x + 1000; } /* in this object's own part of the table (__table_base) */
int (*a_get_static(void))(int) { return a_static; }

/* Weak, so not bound at link time: the object imports it and exports it, and must end up calling its own. */
__attribute__((weak)) int a_hook(int x) { return x + 1; }
int a_calls_hook(int x) { return a_hook(x); }
