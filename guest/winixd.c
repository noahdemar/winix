/* winixd: serves the host page over a /dev/winix channel. Started by /init; handles one request at a time.
 *   EXEC  runs `sh -c script` in cwd with stdout/stderr streamed back, up to max_out bytes each, and a timeout
 *         that kills the command's process group.
 *   WRITE writes a file (creating parent directories); READ returns a file's bytes. */
#define _GNU_SOURCE
#include "winix-proto.h"

#include <poll.h>
#include <sched.h>
#include <signal.h>
#include <sys/wait.h>
#include <time.h>

static int chan;
static struct buf out;

static void reply_err(uint32_t tag, int err, const char *msg)
{
	frame_begin(&out, tag, RP_ERR);
	buf_u32(&out, err);
	buf_str(&out, msg, strlen(msg));
	frame_send(chan, &out);
}

static void reply_empty(uint32_t tag, uint8_t op)
{
	frame_begin(&out, tag, op);
	frame_send(chan, &out);
}

static int64_t now_ms(void)
{
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

struct child_args {
	const char *cwd, *script;
	int out_fd, err_fd;
};

/* Runs in the vfork child: only syscalls, then exec. */
static int exec_child(void *arg)
{
	struct child_args *a = arg;
	int null = open("/dev/null", O_RDONLY);
	setpgid(0, 0);
	if (null >= 0)
		dup2(null, 0);
	dup2(a->out_fd, 1);
	dup2(a->err_fd, 2);
	if (chdir(a->cwd) < 0) {
		static const char msg[] = "winixd: cannot cd to working directory\n";
		write(2, msg, sizeof msg - 1);
		_exit(1);
	}
	execl("/bin/sh", "sh", "-c", a->script, (char *)0);
	_exit(127);
}

/* Reads what is available on *fd and streams it; closes it on EOF. */
static void pump(uint32_t tag, int *fd, uint8_t stream, uint32_t max_out, uint32_t *total)
{
	static uint8_t chunk[65536];
	ssize_t n = read(*fd, chunk, sizeof chunk);
	if (n < 0 && (errno == EAGAIN || errno == EINTR))
		return;
	if (n <= 0) {
		close(*fd);
		*fd = -1;
		return;
	}
	if (*total < max_out) {
		uint32_t keep = (uint32_t)n < max_out - *total ? (uint32_t)n : max_out - *total;
		frame_begin(&out, tag, RP_OUT);
		buf_put(&out, &stream, 1);
		buf_put(&out, chunk, keep);
		frame_send(chan, &out);
	}
	*total += n;
}

static void do_exec(uint32_t tag, struct rd *r)
{
	uint32_t timeout_ms = rd_u32(r), max_out = rd_u32(r), totals[2] = {0, 0};
	char *cwd = rd_cstr(r), *script = rd_cstr(r);
	int po[2], pe[2], fds[2], status = 0, timed_out = 0, exited = 0, code;
	int64_t deadline = now_ms() + timeout_ms;
	struct child_args args;
	pid_t pid;

	if (r->bad || pipe2(po, O_CLOEXEC) || pipe2(pe, O_CLOEXEC)) {
		reply_err(tag, errno, "exec: bad request or pipe failed");
		goto done;
	}
	args = (struct child_args){cwd, script, po[1], pe[1]};
	pid = clone(exec_child, NULL, CLONE_VM | CLONE_VFORK | SIGCHLD, &args);
	close(po[1]);
	close(pe[1]);
	if (pid < 0) {
		close(po[0]);
		close(pe[0]);
		reply_err(tag, errno, "exec: clone failed");
		goto done;
	}
	fds[0] = po[0];
	fds[1] = pe[0];
	fcntl(fds[0], F_SETFL, O_NONBLOCK);
	fcntl(fds[1], F_SETFL, O_NONBLOCK);

	/* Until both pipes hit EOF, or the command exits (background jobs may keep the pipes open), or the deadline. */
	while (fds[0] >= 0 || fds[1] >= 0) {
		struct pollfd p[2] = {{fds[0], POLLIN, 0}, {fds[1], POLLIN, 0}};
		int64_t left = deadline - now_ms();
		if (left <= 0) {
			timed_out = 1;
			break;
		}
		if (exited) {
			/* Drain what is buffered, then stop waiting for background jobs. */
			if (poll(p, 2, 0) <= 0)
				break;
		} else if (poll(p, 2, left < 100 ? (int)left : 100) == 0) {
			exited = waitpid(pid, &status, WNOHANG) == pid;
			continue;
		}
		for (int i = 0; i < 2; i++)
			if (fds[i] >= 0 && (p[i].revents & (POLLIN | POLLHUP | POLLERR)))
				pump(tag, &fds[i], i + 1, max_out, &totals[i]);
	}
	for (int i = 0; i < 2; i++)
		if (fds[i] >= 0)
			close(fds[i]);
	while (!exited && !timed_out) {
		pid_t w = waitpid(pid, &status, WNOHANG);
		if (w == pid || w < 0)
			break;
		if (now_ms() >= deadline)
			timed_out = 1;
		else
			usleep(2000);
	}
	if (timed_out) {
		kill(-pid, SIGKILL);
		kill(pid, SIGKILL);
		waitpid(pid, &status, 0);
	}
	code = timed_out ? 137 : WIFEXITED(status) ? WEXITSTATUS(status) : WIFSIGNALED(status) ? 128 + WTERMSIG(status) : 255;
	frame_begin(&out, tag, RP_EXIT);
	buf_u32(&out, code);
	buf_put(&out, &(uint8_t){timed_out}, 1);
	buf_u32(&out, totals[0]);
	buf_u32(&out, totals[1]);
	frame_send(chan, &out);
done:
	free(cwd);
	free(script);
}

static void mkdirs(char *path)
{
	for (char *s = path + 1; *s; s++) {
		if (*s == '/') {
			*s = 0;
			mkdir(path, 0755);
			*s = '/';
		}
	}
}

static void do_write(uint32_t tag, struct rd *r)
{
	uint32_t mode = rd_u32(r), n;
	char *path = rd_cstr(r);
	const uint8_t *data = rd_blob(r, &n);
	int fd;

	if (r->bad) {
		reply_err(tag, EINVAL, "write: bad request");
	} else {
		mkdirs(path);
		fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, mode ? mode : 0644);
		if (fd < 0 || write_all(fd, data, n))
			reply_err(tag, errno, strerror(errno));
		else
			reply_empty(tag, RP_OK);
		if (fd >= 0)
			close(fd);
	}
	free(path);
}

static void do_read(uint32_t tag, struct rd *r)
{
	char *path = rd_cstr(r);
	struct stat st;
	int fd = open(path, O_RDONLY | O_CLOEXEC);

	if (fd < 0 || fstat(fd, &st) || !S_ISREG(st.st_mode)) {
		reply_err(tag, fd < 0 ? errno : EISDIR, fd < 0 ? strerror(errno) : "not a regular file");
	} else {
		frame_begin(&out, tag, RP_DATA);
		for (;;) {
			uint8_t chunk[65536];
			ssize_t k = read(fd, chunk, sizeof chunk);
			if (k < 0 && errno == EINTR)
				continue;
			if (k <= 0)
				break;
			buf_put(&out, chunk, k);
		}
		frame_send(chan, &out);
	}
	if (fd >= 0)
		close(fd);
	free(path);
}

int main(int argc, char **argv)
{
	setenv("PATH", "/sbin:/usr/sbin:/bin:/usr/bin", 1);
	setenv("HOME", "/root", 1);
	setenv("TERM", "dumb", 1);
	signal(SIGPIPE, SIG_IGN);
	if (access("/dev/null", F_OK))
		mknod("/dev/null", S_IFCHR | 0666, makedev(1, 3));
	mkdir("/tmp", 01777);
	mkdir("/work", 0755);
	mkdir("/root", 0700);

	chan = winix_open_channel();
	if (chan < 0) {
		perror("winixd: /dev/winix");
		return 1;
	}
	reply_empty(0, RP_READY);
	for (;;) {
		uint32_t len;
		uint8_t *f = frame_recv(chan, &len);
		struct rd r;
		uint32_t tag;
		if (!f)
			return 0;
		memcpy(&tag, f, 4);
		r = (struct rd){f + 5, f + len, 0};
		switch (f[4]) {
		case OP_EXEC:
			do_exec(tag, &r);
			break;
		case OP_WRITE:
			do_write(tag, &r);
			break;
		case OP_READ:
			do_read(tag, &r);
			break;
		default:
			reply_err(tag, ENOSYS, "unknown op");
		}
		free(f);
	}
}
