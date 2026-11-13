/* Filesystem session operations for winixd (host side: src/session.js and src/winix.js). Included by winixd.c after
 * its reply helpers. Every operation is one bounded request; listing is iterative (heap queue, no recursion) and
 * never follows symlinks, and it stays on the root filesystem. Excluded trees are never read or written. */
#include <ctype.h>
#include <dirent.h>

#define FS_CHUNK (256u * 1024)
#define FS_MAX_FILE ((uint64_t)512 << 20)
#define FS_MAX_ENTRIES 100000
#define FS_MAX_PATH 4095

static uint8_t fs_buf[FS_CHUNK];

static uint8_t rd_u8(struct rd *r)
{
	if (r->end - r->p < 1) {
		r->bad = 1;
		return 0;
	}
	return *r->p++;
}

static int fs_excluded(const char *p)
{
	static const char *const ex[] = {"/proc", "/sys", "/dev", "/tmp", "/run"};
	for (size_t i = 0; i < sizeof ex / sizeof *ex; i++) {
		size_t n = strlen(ex[i]);
		if (!strncmp(p, ex[i], n) && (p[n] == 0 || p[n] == '/'))
			return 1;
	}
	return 0;
}

static int fs_path_ok(const char *p)
{
	size_t n = strlen(p);
	if (p[0] != '/' || n > FS_MAX_PATH)
		return 0;
	if (strstr(p, "//") || strstr(p, "/./") || strstr(p, "/../"))
		return 0;
	if (n > 1 && p[n - 1] == '/')
		return 0;
	if ((n >= 2 && !strcmp(p + n - 2, "/.")) || (n >= 3 && !strcmp(p + n - 3, "/..")))
		return 0;
	return 1;
}

/* Paths that writing operations may touch: valid, not excluded, and not the root (except for metadata). */
static int fs_writable(const char *p, int allow_root)
{
	return fs_path_ok(p) && !fs_excluded(p) && (allow_root || strcmp(p, "/"));
}

struct fs_queue {
	char **v;
	size_t n, cap;
};

/* Takes ownership of p; on failure p is left to the caller. */
static int fs_push(struct fs_queue *q, char *p)
{
	if (!p)
		return -1;
	if (q->n == q->cap) {
		size_t c = q->cap * 2 + 64;
		char **nv = realloc(q->v, c * sizeof *nv);
		if (!nv)
			return -1;
		q->v = nv;
		q->cap = c;
	}
	q->v[q->n++] = p;
	return 0;
}

static void fs_free_queue(struct fs_queue *q)
{
	for (size_t i = 0; i < q->n; i++)
		free(q->v[i]);
	free(q->v);
	q->v = NULL;
	q->n = q->cap = 0;
}

/* One RP_FS_ENTRY: path, u8 type, u32 mode, uid, gid, sizeLo, sizeHi, str mtimeSec, u32 mtimeNsec, str inode, str target. */
static void fs_emit(uint32_t tag, const char *path, uint8_t type, const struct stat *st, const char *target)
{
	char sec[32], ino[32];
	frame_begin(&out, tag, RP_FS_ENTRY);
	buf_str(&out, path, strlen(path));
	buf_put(&out, &type, 1);
	buf_u32(&out, st ? st->st_mode & 07777 : 0);
	buf_u32(&out, st ? st->st_uid : 0);
	buf_u32(&out, st ? st->st_gid : 0);
	buf_u32(&out, st ? (uint32_t)st->st_size : 0);
	buf_u32(&out, st ? (uint32_t)((uint64_t)st->st_size >> 32) : 0);
	snprintf(sec, sizeof sec, "%lld", st ? (long long)st->st_mtim.tv_sec : 0LL);
	buf_str(&out, sec, strlen(sec));
	buf_u32(&out, st ? (uint32_t)st->st_mtim.tv_nsec : 0);
	snprintf(ino, sizeof ino, "%llu", st ? (unsigned long long)st->st_ino : 0ULL);
	buf_str(&out, ino, strlen(ino));
	buf_str(&out, target, strlen(target));
	frame_send(chan, &out);
}

/* Replies with an error and releases the path and the queue. */
static void list_fail(uint32_t tag, struct fs_queue *q, char *path, int err, const char *msg)
{
	free(path);
	fs_free_queue(q);
	reply_err(tag, err ? err : EIO, msg);
}

static void do_fs_list(uint32_t tag)
{
	struct fs_queue q = {0};
	struct stat root;
	char *start = strdup("/");
	size_t discovered = 1;
	if (!start) {
		reply_err(tag, ENOMEM, "list: out of memory");
		return;
	}
	if (lstat("/", &root) || fs_push(&q, start)) {
		int err = errno ? errno : ENOMEM;
		free(start);
		reply_err(tag, err, "list: cannot start");
		return;
	}
	while (q.n) {
		char *path = q.v[--q.n];
		struct stat st;
		char target[4096] = "";
		int isroot = !strcmp(path, "/");
		size_t plen = strlen(path);
		if (lstat(path, &st)) {
			list_fail(tag, &q, path, errno, "list: lstat failed");
			return;
		}
		if (!isroot && fs_excluded(path)) {
			fs_emit(tag, path, 'o', NULL, "excluded");
		} else if (!isroot && st.st_dev != root.st_dev) {
			fs_emit(tag, path, 'o', NULL, "mount");
		} else if (S_ISDIR(st.st_mode)) {
			DIR *d = opendir(path);
			struct dirent *de;
			if (!d) {
				list_fail(tag, &q, path, errno, "list: opendir failed");
				return;
			}
			fs_emit(tag, path, 'd', &st, "");
			errno = 0;
			while ((de = readdir(d))) {
				char *child;
				size_t nl = strlen(de->d_name), clen = (isroot ? 0 : plen) + 1 + nl;
				if (!strcmp(de->d_name, ".") || !strcmp(de->d_name, ".."))
					continue;
				if (clen > FS_MAX_PATH || discovered >= FS_MAX_ENTRIES) {
					closedir(d);
					list_fail(tag, &q, path, clen > FS_MAX_PATH ? ENAMETOOLONG : EFBIG,
						  "list: path or entry limit exceeded");
					return;
				}
				child = malloc(clen + 1);
				if (!child || fs_push(&q, child)) {
					free(child);
					closedir(d);
					list_fail(tag, &q, path, ENOMEM, "list: out of memory");
					return;
				}
				sprintf(child, "%s/%s", isroot ? "" : path, de->d_name);
				discovered++;
			}
			if (errno) {
				int err = errno;
				closedir(d);
				list_fail(tag, &q, path, err, "list: readdir failed");
				return;
			}
			closedir(d);
		} else if (S_ISLNK(st.st_mode)) {
			ssize_t n = readlink(path, target, sizeof target - 1);
			if (n < 0) {
				list_fail(tag, &q, path, errno, "list: readlink failed");
				return;
			}
			target[n] = 0;
			fs_emit(tag, path, 'l', &st, target);
		} else if (S_ISREG(st.st_mode)) {
			fs_emit(tag, path, 'f', &st, "");
		} else {
			fs_emit(tag, path, 'o', NULL, "special file");
		}
		free(path);
	}
	fs_free_queue(&q);
	reply_empty(tag, RP_OK);
}

static void do_fs_read(uint32_t tag, struct rd *r)
{
	char *path = rd_cstr(r);
	uint32_t off = rd_u32(r), len = rd_u32(r), got = 0;
	struct stat st;
	int fd = -1;
	if (r->bad || len > FS_CHUNK || (uint64_t)off + len > FS_MAX_FILE || !fs_writable(path, 0)) {
		reply_err(tag, EINVAL, "read: bad request");
	} else if ((fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK)) < 0 || fstat(fd, &st) ||
		   !S_ISREG(st.st_mode)) {
		reply_err(tag, fd < 0 ? errno : EISDIR, "read: not a regular file");
	} else {
		int err = 0;
		while (got < len) {
			ssize_t k = pread(fd, fs_buf + got, len - got, (off_t)off + got);
			if (k < 0 && errno == EINTR)
				continue;
			if (k < 0) {
				err = errno;
				break;
			}
			if (k == 0)
				break;
			got += k;
		}
		if (err) {
			reply_err(tag, err, strerror(err));
		} else {
			frame_begin(&out, tag, RP_DATA);
			buf_put(&out, fs_buf, got);
			frame_send(chan, &out);
		}
	}
	if (fd >= 0)
		close(fd);
	free(path);
}

/* truncate is 0 or 1; a truncating write starts at offset 0 (the first chunk of a file). */
static void do_fs_write(uint32_t tag, struct rd *r)
{
	char *path = rd_cstr(r);
	uint32_t off = rd_u32(r), n = 0;
	uint8_t trunc = rd_u8(r);
	const uint8_t *data = rd_blob(r, &n);
	struct stat st;
	int fd = -1, err = 0;
	if (r->bad || n > FS_CHUNK || trunc > 1 || (trunc && off) || (uint64_t)off + n > FS_MAX_FILE ||
	    !fs_writable(path, 0)) {
		reply_err(tag, EINVAL, "write: bad request");
	} else if ((fd = open(path, O_WRONLY | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0600)) < 0 || fstat(fd, &st) ||
		   !S_ISREG(st.st_mode)) {
		reply_err(tag, fd < 0 ? errno : EISDIR, "write: not a regular file");
	} else {
		if (trunc && ftruncate(fd, 0))
			err = errno;
		for (uint32_t done = 0; !err && done < n;) {
			ssize_t k = pwrite(fd, data + done, n - done, (off_t)off + done);
			if (k < 0 && errno == EINTR)
				continue;
			if (k <= 0)
				err = errno ? errno : EIO;
			else
				done += k;
		}
		if (close(fd) && !err)
			err = errno;
		fd = -1;
		if (err)
			reply_err(tag, err, strerror(err));
		else
			reply_empty(tag, RP_OK);
	}
	if (fd >= 0)
		close(fd);
	free(path);
}

/* kind 'd' (mkdir 0755), 'l' (symlink target -> path), 'h' (hard link path -> existing file target). */
static void do_fs_node(uint32_t tag, struct rd *r)
{
	uint8_t kind = rd_u8(r);
	char *path = rd_cstr(r), *target = rd_cstr(r);
	int rc = -1;
	if (r->bad || !fs_writable(path, 0) || (kind == 'h' && !fs_path_ok(target))) {
		errno = EINVAL;
	} else if (kind == 'd') {
		rc = mkdir(path, 0755);
		if (rc && errno == EEXIST) {
			struct stat st;
			if (!lstat(path, &st) && S_ISDIR(st.st_mode))
				rc = 0;
		}
	} else if (kind == 'l') {
		rc = symlink(target, path);
	} else if (kind == 'h') {
		rc = linkat(AT_FDCWD, target, AT_FDCWD, path, 0);
	} else {
		errno = EINVAL;
	}
	if (rc)
		reply_err(tag, errno, strerror(errno));
	else
		reply_empty(tag, RP_OK);
	free(path);
	free(target);
}

/* Strict decimal seconds: optional '-', then digits only. */
static int meta_secs_ok(const char *s)
{
	if (*s == '-')
		s++;
	if (!isdigit((unsigned char)*s))
		return 0;
	for (; *s; s++)
		if (!isdigit((unsigned char)*s))
			return 0;
	return 1;
}

/* Applies owner, mode (not for links), and times: utimensat with AT_SYMLINK_NOFOLLOW for links. Raw ids and modes are
 * validated, never masked: mode must be 0..07777 and the ids must not be -1 (which chown treats as "unchanged"). */
static void do_fs_meta(uint32_t tag, struct rd *r)
{
	char *path = rd_cstr(r);
	uint32_t mode = rd_u32(r), uid = rd_u32(r), gid = rd_u32(r);
	char *sec = rd_cstr(r);
	uint32_t nsec = rd_u32(r);
	uint8_t is_link = rd_u8(r);
	struct timespec ts[2];
	struct stat st;
	char *end = sec;
	long long s;
	int err = 0;
	errno = 0;
	s = strtoll(sec, &end, 10);
	if (r->bad || !fs_writable(path, 1) || !meta_secs_ok(sec) || *end || errno || nsec > 999999999u ||
	    mode > 07777 || uid == 0xffffffffu || gid == 0xffffffffu || is_link > 1) {
		reply_err(tag, EINVAL, "meta: bad request");
	} else if (lstat(path, &st)) {
		reply_err(tag, errno, "meta: lstat failed");
	} else if (S_ISLNK(st.st_mode) != !!is_link) {
		reply_err(tag, EINVAL, "meta: file type changed");
	} else {
		ts[0] = ts[1] = (struct timespec){(time_t)s, (long)nsec};
		if (lchown(path, uid, gid))
			err = errno;
		else if (!is_link && chmod(path, mode))
			err = errno;
		else if (utimensat(AT_FDCWD, path, ts, is_link ? AT_SYMLINK_NOFOLLOW : 0))
			err = errno;
		if (err)
			reply_err(tag, err, strerror(err));
		else
			reply_empty(tag, RP_OK);
	}
	free(path);
	free(sec);
}

static void do_fs_remove(uint32_t tag, struct rd *r)
{
	char *path = rd_cstr(r);
	struct stat st;
	int rc;
	if (r->bad || !fs_writable(path, 0)) {
		reply_err(tag, EINVAL, "remove: bad request");
	} else if (lstat(path, &st)) {
		reply_err(tag, errno, "remove: lstat failed");
	} else {
		rc = S_ISDIR(st.st_mode) ? rmdir(path) : unlink(path);
		if (rc)
			reply_err(tag, errno, strerror(errno));
		else
			reply_empty(tag, RP_OK);
	}
	free(path);
}
