# Memory-operand indirect call/jmp loops for the Blink wasm JIT regression (tests/jit-indirect.mjs).
# Each loop runs its indirect transfer 20000 times and returns the sum of results.

	.text
	.globl _start, fn_a, fn_b, loop_disp, loop_jmp, loop_rip, loop_sib, loop_alt, loop_cross, loop_sp, loop_addr32, loop_fs, loop_stackcross

_start:
	xor %ebp, %ebp
	and $-16, %rsp
	call driver
	hlt

fn_a:
	mov $1, %eax
	ret
fn_b:
	mov $2, %eax
	ret

# call *8(%rbx): base register plus displacement; table entry at 8 holds fn_a
loop_disp:
	push %rbx
	push %r12
	push %r13
	mov %rdi, %rbx
	mov $20000, %r12d
	xor %r13d, %r13d
1:	call *8(%rbx)
	add %eax, %r13d
	dec %r12d
	jnz 1b
	mov %r13, %rax
	pop %r13
	pop %r12
	pop %rbx
	ret

# jmp *8(%rbx): the target is a label that loops back through the same jmp
loop_jmp:
	push %rbx
	push %r12
	push %r13
	mov %rdi, %rbx
	mov $20000, %r12d
	xor %r13d, %r13d
	jmp *8(%rbx)
Lj:
	add $1, %r13d
	dec %r12d
	jz 2f
	jmp *8(%rbx)
2:	mov %r13, %rax
	pop %r13
	pop %r12
	pop %rbx
	ret

# call *fnslot(%rip): RIP-relative operand
loop_rip:
	push %r12
	push %r13
	mov $20000, %r12d
	xor %r13d, %r13d
1:	call *fnslot(%rip)
	add %eax, %r13d
	dec %r12d
	jnz 1b
	mov %r13, %rax
	pop %r13
	pop %r12
	ret

# call *8(%rbx,%r14,8): scaled index with an extended register; alternates fn_a and fn_b
loop_sib:
	push %rbx
	push %r12
	push %r13
	push %r14
	mov %rdi, %rbx
	mov $20000, %r12d
	xor %r13d, %r13d
	xor %r14d, %r14d
1:	call *8(%rbx,%r14,8)
	add %eax, %r13d
	xor $1, %r14d
	dec %r12d
	jnz 1b
	mov %r13, %rax
	pop %r14
	pop %r13
	pop %r12
	pop %rbx
	ret

# the same slot is rewritten to fn_a / fn_b before every call
loop_alt:
	push %rbx
	push %r12
	push %r13
	mov %rdi, %rbx
	mov $20000, %r12d
	xor %r13d, %r13d
1:	lea fn_a(%rip), %rax
	test $1, %r12d
	jnz 2f
	lea fn_b(%rip), %rax
2:	mov %rax, 8(%rbx)
	call *8(%rbx)
	add %eax, %r13d
	dec %r12d
	jnz 1b
	mov %r13, %rax
	pop %r13
	pop %r12
	pop %rbx
	ret

# call *0(%rbx) where the 8-byte pointer straddles a page boundary (slow fallback)
loop_cross:
	push %rbx
	push %r12
	push %r13
	mov %rdi, %rbx
	mov $20000, %r12d
	xor %r13d, %r13d
1:	call *0(%rbx)
	add %eax, %r13d
	dec %r12d
	jnz 1b
	mov %r13, %rax
	pop %r13
	pop %r12
	pop %rbx
	ret

# the target is stored at -8(%rsp), where the call pushes its return address
loop_sp:
	push %r12
	push %r13
	mov $20000, %r12d
	xor %r13d, %r13d
1:	lea fn_a(%rip), %rax
	mov %rax, -8(%rsp)
	call *-8(%rsp)
	add %eax, %r13d
	dec %r12d
	jnz 1b
	mov %r13, %rax
	pop %r13
	pop %r12
	ret

# addr32 prefix: call *8(%ebx) uses a 32-bit effective address
loop_addr32:
	push %rbx
	push %r12
	push %r13
	mov %rdi, %rbx
	mov $20000, %r12d
	xor %r13d, %r13d
1:	.byte 0x67, 0xff, 0x53, 0x08
	add %eax, %r13d
	dec %r12d
	jnz 1b
	mov %r13, %rax
	pop %r13
	pop %r12
	pop %rbx
	ret

# call *%fs:8: FS-segment override with an absolute displacement (no base, no index).
# FS base is set to tab with arch_prctl(ARCH_SET_FS) and reset to 0 before returning.
loop_fs:
	push %r12
	push %r13
	mov $158, %eax
	mov $0x1002, %edi
	lea tab(%rip), %rsi
	syscall
	mov $20000, %r12d
	xor %r13d, %r13d
1:	call *%fs:8
	add %eax, %r13d
	dec %r12d
	jnz 1b
	mov $158, %eax
	mov $0x1002, %edi
	xor %esi, %esi
	syscall
	mov %r13, %rax
	pop %r13
	pop %r12
	ret

# The stack is moved to a scratch buffer whose top is 4100 bytes into a page, so each
# call's 8-byte return-address push and the ret pop straddle a page boundary.
loop_stackcross:
	push %rbx
	push %r12
	push %r13
	push %r15
	mov %rdi, %rbx
	mov %rsp, %r15
	lea stkbuf(%rip), %rax
	lea 4100(%rax), %rsp
	mov $20000, %r12d
	xor %r13d, %r13d
1:	call *8(%rbx)
	add %eax, %r13d
	dec %r12d
	jnz 1b
	mov %r15, %rsp
	mov %r13, %rax
	pop %r15
	pop %r13
	pop %r12
	pop %rbx
	ret

	.bss
	.p2align 12
stkbuf:
	.zero 8192

	.data
	.p2align 12
	.globl tab, jtab, alttab, fnslot, crosspage
tab:
	.quad 0
	.quad fn_a
	.quad fn_b
	.quad 0
jtab:
	.quad 0
	.quad Lj
alttab:
	.quad 0
	.quad 0
fnslot:
	.quad fn_a
	.p2align 12
crosspage:
	.zero 4092
	.quad fn_a
