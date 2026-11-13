/* A CPython extension module for tests/dlopen.mjs: the ways an extension leans on the interpreter that loaded it.
 * Built by packages/dltest.sh (when the python package has been built) as _dltest.so. */
#define PY_SSIZE_T_CLEAN
#include <Python.h>

typedef struct {
	PyObject_HEAD
	long value;
} Counter;

static PyObject *Counter_bump(Counter *self, PyObject *Py_UNUSED(ignored))
{
	self->value++;
	Py_RETURN_NONE;
}

static PyObject *Counter_get_value(Counter *self, void *Py_UNUSED(closure))
{
	return PyLong_FromLong(self->value);
}

static PyMethodDef Counter_methods[] = {
	{ "bump", (PyCFunction)Counter_bump, METH_NOARGS, "Add one." },
	{ 0 },
};

static PyGetSetDef Counter_getset[] = {
	{ "value", (getter)Counter_get_value, 0, "The count.", 0 },
	{ 0 },
};

/* A static type: its slots hold the addresses of interpreter functions, which the interpreter compares with its own
 * (PyType_GenericNew, PyObject_GenericGetAttr), so they must be the same function pointers. */
static PyTypeObject CounterType = {
	PyVarObject_HEAD_INIT(NULL, 0)
	.tp_name = "_dltest.Counter",
	.tp_basicsize = sizeof(Counter),
	.tp_flags = Py_TPFLAGS_DEFAULT | Py_TPFLAGS_BASETYPE,
	.tp_new = PyType_GenericNew,
	.tp_getattro = PyObject_GenericGetAttr,
	.tp_methods = Counter_methods,
	.tp_getset = Counter_getset,
};

static PyObject *dltest_add(PyObject *Py_UNUSED(self), PyObject *args)
{
	long a, b;
	if (!PyArg_ParseTuple(args, "ll", &a, &b))
		return NULL;
	return PyLong_FromLong(a + b);
}

static PyObject *dltest_fail(PyObject *Py_UNUSED(self), PyObject *Py_UNUSED(ignored))
{
	PyErr_SetString(PyExc_ValueError, "raised in C");
	return NULL;
}

static PyObject *dltest_apply(PyObject *Py_UNUSED(self), PyObject *args)
{
	PyObject *f, *x;
	if (!PyArg_ParseTuple(args, "OO", &f, &x))
		return NULL;
	return PyObject_CallFunctionObjArgs(f, x, NULL);
}

static PyObject *dltest_same_pointers(PyObject *Py_UNUSED(self), PyObject *Py_UNUSED(ignored))
{
	return PyBool_FromLong(PyBaseObject_Type.tp_getattro == PyObject_GenericGetAttr
		&& PyLong_Type.tp_free == PyObject_Free);
}

static PyMethodDef methods[] = {
	{ "add", dltest_add, METH_VARARGS, "add(a, b)" },
	{ "fail", dltest_fail, METH_NOARGS, "Raise ValueError." },
	{ "apply", dltest_apply, METH_VARARGS, "apply(f, x) calls f(x)." },
	{ "same_pointers", dltest_same_pointers, METH_NOARGS, "Interpreter functions have one address." },
	{ 0 },
};

static struct PyModuleDef module = { PyModuleDef_HEAD_INIT, "_dltest", "dlopen test module", -1, methods };

PyMODINIT_FUNC PyInit__dltest(void)
{
	PyObject *m;
	if (PyType_Ready(&CounterType) < 0)
		return NULL;
	m = PyModule_Create(&module);
	if (!m)
		return NULL;
	Py_INCREF(&CounterType);
	if (PyModule_AddObject(m, "Counter", (PyObject *)&CounterType) < 0 || PyModule_AddIntConstant(m, "answer", 42) < 0) {
		Py_DECREF(m);
		return NULL;
	}
	return m;
}
