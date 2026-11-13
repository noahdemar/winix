/* Frames on /dev/winix (both directions, little-endian):
 *   u32 len (of everything after this field) | u32 tag | u8 op | payload
 * Strings and byte blobs in payloads are u32 length + bytes. Must match src/winix.js. */
#ifndef WINIX_PROTO_H
#define WINIX_PROTO_H

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <unistd.h>

enum {
	/* host -> winixd */
	OP_EXEC = 1,  /* u32 timeout_ms, u32 max_out, str cwd, str script */
	OP_WRITE = 2, /* u32 mode, str path, blob data */
	OP_READ = 3,  /* str path */
	/* guest client -> host */
	OP_FETCH = 0x10, /* u8 flags, str method, str url, str headers ("k: v\n"...), blob body */
	/* replies */
	RP_OUT = 0x81,   /* u8 stream (1 stdout, 2 stderr), bytes... */
	RP_EXIT = 0x82,  /* i32 code, u8 timed_out, u32 out_total, u32 err_total */
	RP_OK = 0x83,    /* (empty) */
	RP_ERR = 0x84,   /* i32 errno, str message */
	RP_DATA = 0x85,  /* bytes... */
	RP_READY = 0x86, /* (empty), winixd up */
	RP_RESP = 0x90,  /* u32 status, str status_text, str headers ("k: v\n"...) */
	RP_BODY = 0x91,  /* bytes... */
	RP_END = 0x92,   /* (empty) */
	/* session filesystem (guest/session-fs.h): see src/session.js */
	OP_FS_LIST = 0x20,   /* (empty) -> RP_FS_ENTRY... then RP_OK */
	OP_FS_READ = 0x21,   /* str path, u32 offset, u32 length -> RP_DATA */
	OP_FS_WRITE = 0x22,  /* str path, u32 offset, u8 truncate, blob data -> RP_OK */
	OP_FS_NODE = 0x23,   /* u8 kind (d/l/h), str path, str target -> RP_OK */
	OP_FS_META = 0x24,   /* str path, u32 mode, uid, gid, str mtime_sec, u32 mtime_nsec, u8 is_link -> RP_OK */
	OP_FS_REMOVE = 0x25, /* str path -> RP_OK */
	RP_FS_ENTRY = 0x87,  /* str path, u8 type, u32 mode, uid, gid, size_lo, size_hi, str mtime_sec, u32 mtime_nsec,
	                        str inode, str target */
};

struct buf {
	uint8_t *p;
	size_t len, cap;
};

static void buf_put(struct buf *b, const void *d, size_t n)
{
	if (b->len + n > b->cap) {
		b->cap = (b->len + n) * 2 + 64;
		b->p = realloc(b->p, b->cap);
		if (!b->p)
			_exit(111);
	}
	memcpy(b->p + b->len, d, n);
	b->len += n;
}

static void buf_u32(struct buf *b, uint32_t v)
{
	buf_put(b, &v, 4); /* wasm is little-endian */
}

static void buf_str(struct buf *b, const void *d, size_t n)
{
	buf_u32(b, n);
	buf_put(b, d, n);
}

static int write_all(int fd, const void *d, size_t n)
{
	const uint8_t *p = d;
	while (n) {
		ssize_t w = write(fd, p, n);
		if (w < 0 && errno == EINTR)
			continue;
		if (w <= 0)
			return -1;
		p += w;
		n -= w;
	}
	return 0;
}

static int read_all(int fd, void *d, size_t n)
{
	uint8_t *p = d;
	while (n) {
		ssize_t r = read(fd, p, n);
		if (r < 0 && errno == EINTR)
			continue;
		if (r <= 0)
			return -1;
		p += r;
		n -= r;
	}
	return 0;
}

/* Starts a frame in b (len is patched by frame_send). */
static void frame_begin(struct buf *b, uint32_t tag, uint8_t op)
{
	b->len = 0;
	buf_u32(b, 0);
	buf_u32(b, tag);
	buf_put(b, &op, 1);
}

static int frame_send(int fd, struct buf *b)
{
	uint32_t n = b->len - 4;
	memcpy(b->p, &n, 4);
	return write_all(fd, b->p, b->len);
}

/* Reads one frame; returns malloc'd body (tag, op, payload) and its length, or NULL on EOF. */
static uint8_t *frame_recv(int fd, uint32_t *len)
{
	uint8_t *p;
	if (read_all(fd, len, 4) || *len < 5)
		return NULL;
	p = malloc(*len);
	if (!p || read_all(fd, p, *len)) {
		free(p);
		return NULL;
	}
	return p;
}

/* Payload reader. */
struct rd {
	const uint8_t *p, *end;
	int bad;
};

static uint32_t rd_u32(struct rd *r)
{
	uint32_t v = 0;
	if (r->end - r->p < 4) {
		r->bad = 1;
		return 0;
	}
	memcpy(&v, r->p, 4);
	r->p += 4;
	return v;
}

/* Returns a pointer into the frame; *n is its length. NUL-terminated copy via rd_cstr. */
static const uint8_t *rd_blob(struct rd *r, uint32_t *n)
{
	const uint8_t *s;
	*n = rd_u32(r);
	if (r->bad || (size_t)(r->end - r->p) < *n) {
		r->bad = 1;
		*n = 0;
		return r->p;
	}
	s = r->p;
	r->p += *n;
	return s;
}

static char *rd_cstr(struct rd *r)
{
	uint32_t n;
	const uint8_t *s = rd_blob(r, &n);
	char *c = malloc(n + 1);
	if (!c)
		_exit(111);
	memcpy(c, s, n);
	c[n] = 0;
	return c;
}

/* Opens a new channel, creating /dev/winix from /proc/misc if needed (no devtmpfs). */
static int winix_open_channel(void)
{
	int fd = open("/dev/winix", O_RDWR | O_CLOEXEC);
	if (fd < 0 && errno == ENOENT) {
		FILE *f = fopen("/proc/misc", "r");
		int minor;
		char name[64];
		while (f && fscanf(f, "%d %63s", &minor, name) == 2) {
			if (!strcmp(name, "winix")) {
				mknod("/dev/winix", S_IFCHR | 0666, makedev(10, minor));
				break;
			}
		}
		if (f)
			fclose(f);
		fd = open("/dev/winix", O_RDWR | O_CLOEXEC);
	}
	return fd;
}

#endif
