# Register-only semantic tier regression (tests/jit-trace.mjs). Each case loops 20000 times so its code is compiled.
# A case returns its value in rax and stores the flags of its last ALU op (masked by the driver) through its argument.

	.text
	.globl _start, case_zext, case_chain, case_wrap, case_ovf, case_borrow, case_deadlive, case_carry, case_mem, case_call, case_branch, case_nimm, case_flagbarrier

_start:
	xor %ebp, %ebp
	and $-16, %rsp
	call driver
	hlt

	.macro PROLOGUE
	push %rbx
	push %r12
	push %r13
	push %r14
	push %r15
	mov %rdi, %r15
	mov $20000, %r12d
	xor %r13d, %r13d
	.endm

	.macro EPILOGUE
	pop %r15
	pop %r14
	pop %r13
	pop %r12
	pop %rbx
	ret
	.endm

# 32-bit zero extension and partial registers: eax=0x89abcdef, ax=0xbeef, ah=0x42, al=0x55
case_zext:
	PROLOGUE
1:	movabs $0x1122334455667788, %rax
	mov $0x89abcdef, %eax
	mov $0xbeef, %ax
	mov $0x42, %ah
	mov $0x55, %al
	mov %eax, %ecx
	mov %rcx, %rdx
	mov %rdx, %rax
	dec %r12d
	jnz 1b
	EPILOGUE

# 64-bit mov/add/sub/or/and/xor over r8..r14, 42 per call, summed in r13 (840000 over 20000)
case_chain:
	PROLOGUE
1:	mov $100, %r8
	mov $60, %r9
	sub %r9, %r8
	mov %r8, %r10
	add $5, %r10
	mov $3, %r11
	sub %r11, %r10
	xor %r14, %r14
	or %r10, %r14
	and %r10, %r14
	add %r14, %r13
	dec %r12d
	jnz 1b
	mov %r13, %rax
	EPILOGUE

# 32-bit wrap: eax=0xffffffff+1 -> 0, flags CF PF AF ZF
case_wrap:
	PROLOGUE
1:	mov $0xffffffff, %eax
	add $1, %eax
	pushfq
	pop %rdx
	mov %rdx, (%r15)
	dec %r12d
	jnz 1b
	EPILOGUE

# signed overflow: 0x7fffffffffffffff+1 -> 0x8000000000000000, flags PF AF SF OF
case_ovf:
	PROLOGUE
1:	movabs $0x7fffffffffffffff, %rax
	add $1, %rax
	pushfq
	pop %rdx
	mov %rdx, (%r15)
	dec %r12d
	jnz 1b
	EPILOGUE

# borrow: 0-1 -> all ones, flags CF PF AF SF
case_borrow:
	PROLOGUE
1:	xor %eax, %eax
	sub $1, %rax
	pushfq
	pop %rdx
	mov %rdx, (%r15)
	dec %r12d
	jnz 1b
	EPILOGUE

# dead flags (add) followed by live flags (xor ebx,ebx): eax=15, flags PF ZF
case_deadlive:
	PROLOGUE
1:	mov $10, %eax
	add $5, %eax
	xor %ebx, %ebx
	pushfq
	pop %rdx
	mov %rdx, (%r15)
	dec %r12d
	jnz 1b
	EPILOGUE

# fallback carry: stc and adc are not supported, mov is; eax = 7 + 5 + carry = 13
case_carry:
	PROLOGUE
1:	stc
	mov $7, %eax
	adc $5, %eax
	dec %r12d
	jnz 1b
	EPILOGUE

# promoted value stored to a static slot and reloaded: 42
case_mem:
	PROLOGUE
1:	mov $40, %ecx
	add $2, %ecx
	mov %ecx, memslot(%rip)
	mov memslot(%rip), %eax
	dec %r12d
	jnz 1b
	EPILOGUE

# promoted ALU state crosses a call to an unsupported helper: (3 + 5) * 2 = 16
case_call:
	PROLOGUE
1:	mov $3, %eax
	add $5, %eax
	call dbl_helper
	dec %r12d
	jnz 1b
	EPILOGUE

dbl_helper:
	imul $2, %rax, %rax
	ret

# compare and conditional jump after promoted ALU ops: 42, the jump is not suppressed
case_branch:
	PROLOGUE
1:	mov $40, %eax
	add $2, %eax
	cmp $42, %eax
	jne 8f
	jmp 7f
8:	mov $0xdead, %eax
7:	dec %r12d
	jnz 1b
	EPILOGUE

# negative immediates: mov $-1 (REX.W c7 /0, imm32 sign-extended), add $-5 (83 /0, imm8): -6
case_nimm:
	PROLOGUE
1:	mov $-1, %r8
	add $-5, %r8
	mov %r8, %rax
	dec %r12d
	jnz 1b
	EPILOGUE

# the add's flags must survive: pushfq (a barrier) observes them before the xor/mov overwrite them
case_flagbarrier:
	PROLOGUE
1:	mov $0xffffffff, %eax
	add $1, %eax
	mov $123, %ebx
	pushfq
	pop %rdx
	mov %rdx, (%r15)
	xor %ebx, %ebx
	mov $0, %eax
	dec %r12d
	jnz 1b
	EPILOGUE

	.data
	.p2align 3
memslot:
	.quad 0
