/* curl: HTTP(S) through the host page's fetch() over a /dev/winix channel (the guest has no sockets).
 * Supports the common flags: -s -S -f -L -i -I -N -o FILE -O -X METHOD -H HEADER -d/--data/--data-raw/--data-binary
 * (@file reads a file, @- stdin) -A UA -w '%{http_code}' --fail-with-body. Redirects are always followed.
 * Response bodies stream: each chunk the host reads is written out as it arrives (SSE, LLM token streams). */
#define _GNU_SOURCE
#include "winix-proto.h"

static const char *prog = "curl";
static int silent, show_error;

static void die(int code, const char *msg)
{
	if (!silent || show_error)
		fprintf(stderr, "%s: (%d) %s\n", prog, code, msg);
	exit(code);
}

static void usage(void)
{
	fprintf(stderr, "usage: %s [-sSfLiI] [-o FILE|-O] [-X METHOD] [-H HEADER]... [-d DATA] [-A UA] [-w FMT] URL\n", prog);
	exit(2);
}

static void slurp(const char *name, struct buf *b)
{
	int fd = strcmp(name, "-") ? open(name, O_RDONLY) : 0;
	uint8_t chunk[65536];
	ssize_t n;
	if (fd < 0)
		die(26, "can't read data file");
	while ((n = read(fd, chunk, sizeof chunk)) > 0)
		buf_put(b, chunk, n);
	if (fd)
		close(fd);
}

int main(int argc, char **argv)
{
	const char *method = NULL, *url = NULL, *outfile = NULL, *wfmt = NULL;
	struct buf headers = {0}, body = {0}, f = {0};
	int fail = 0, fail_body = 0, include = 0, head = 0, remote_name = 0, has_body = 0, chan, ofd = 1;
	uint32_t status = 0;

	prog = strrchr(argv[0], '/') ? strrchr(argv[0], '/') + 1 : argv[0];
	for (int i = 1; i < argc; i++) {
		const char *a = argv[i];
#define NEXT() (i + 1 < argc ? argv[++i] : (usage(), ""))
		if (!strcmp(a, "-X") || !strcmp(a, "--request")) method = NEXT();
		else if (!strcmp(a, "-H") || !strcmp(a, "--header")) { const char *h = NEXT(); buf_put(&headers, h, strlen(h)); buf_put(&headers, "\n", 1); }
		else if (!strcmp(a, "-A") || !strcmp(a, "--user-agent")) { const char *h = NEXT(); buf_put(&headers, "User-Agent: ", 12); buf_put(&headers, h, strlen(h)); buf_put(&headers, "\n", 1); }
		else if (!strcmp(a, "-d") || !strcmp(a, "--data") || !strcmp(a, "--data-binary") || !strcmp(a, "--data-raw")) {
			const char *d = NEXT();
			if (has_body && strcmp(a, "--data-binary")) buf_put(&body, "&", 1);
			if (d[0] == '@' && strcmp(a, "--data-raw")) slurp(d + 1, &body);
			else buf_put(&body, d, strlen(d));
			has_body = 1;
		}
		else if (!strcmp(a, "-o") || !strcmp(a, "--output")) outfile = NEXT();
		else if (!strcmp(a, "-w") || !strcmp(a, "--write-out")) wfmt = NEXT();
		else if (!strcmp(a, "--fail-with-body")) fail_body = 1;
		else if (!strcmp(a, "--silent")) silent = 1;
		else if (!strcmp(a, "--show-error")) show_error = 1;
		else if (!strcmp(a, "--fail")) fail = 1;
		else if (!strcmp(a, "--location") || !strcmp(a, "--compressed")) ;
		else if (!strcmp(a, "--include")) include = 1;
		else if (!strcmp(a, "--head")) head = 1;
		else if (!strcmp(a, "--remote-name")) remote_name = 1;
		else if (!strcmp(a, "--no-buffer")) ; /* body chunks are written as they arrive; nothing to turn off */
		else if (a[0] == '-' && a[1] && a[1] != '-') {
			for (const char *c = a + 1; *c; c++) {
				switch (*c) {
				case 's': silent = 1; break;
				case 'S': show_error = 1; break;
				case 'f': fail = 1; break;
				case 'L': break;
				case 'i': include = 1; break;
				case 'I': head = 1; break;
				case 'O': remote_name = 1; break;
				case 'k': break;
				case 'N': break; /* see --no-buffer */
				default: usage();
				}
			}
		}
		else if (a[0] != '-') url = a;
		else usage();
	}
	if (!url)
		usage();
	if (!strstr(url, "://")) {
		char *u;
		if (asprintf(&u, "http://%s", url) < 0)
			exit(1);
		url = u;
	}
	if (!method)
		method = head ? "HEAD" : has_body ? "POST" : "GET";
	buf_put(&headers, "", 1); /* NUL-terminate for strcasestr, then drop it */
	headers.len--;
	if (has_body && !strcasestr((char *)headers.p, "content-type:"))
		buf_put(&headers, "Content-Type: application/x-www-form-urlencoded\n", 48);
	if (remote_name) {
		const char *s = strrchr(url, '/');
		outfile = s && s[1] && !strchr(s, '?') ? s + 1 : "index.html";
	}

	chan = winix_open_channel();
	if (chan < 0)
		die(7, "no /dev/winix channel to the host");
	frame_begin(&f, 1, OP_FETCH);
	buf_put(&f, &(uint8_t){0}, 1);
	buf_str(&f, method, strlen(method));
	buf_str(&f, url, strlen(url));
	buf_str(&f, headers.p, headers.len);
	buf_str(&f, body.p, body.len);
	if (frame_send(chan, &f))
		die(7, "write to host failed");

	for (;;) {
		uint32_t len, n;
		uint8_t *fr = frame_recv(chan, &len);
		struct rd r;
		if (!fr)
			die(56, "connection to host closed");
		r = (struct rd){fr + 5, fr + len, 0};
		switch (fr[4]) {
		case RP_RESP: {
			const uint8_t *text, *hdrs;
			uint32_t tn;
			status = rd_u32(&r);
			text = rd_blob(&r, &tn);
			hdrs = rd_blob(&r, &n);
			if (fail && !fail_body && status >= 400) {
				char msg[80];
				snprintf(msg, sizeof msg, "The requested URL returned error: %u", status);
				die(22, msg);
			}
			if (outfile && (ofd = open(outfile, O_WRONLY | O_CREAT | O_TRUNC, 0644)) < 0)
				die(23, "can't open output file");
			if (include || head) {
				char line[64];
				int k = snprintf(line, sizeof line, "HTTP/1.1 %u ", status);
				write_all(ofd, line, k);
				write_all(ofd, text, tn);
				write_all(ofd, "\r\n", 2);
				for (const uint8_t *p = hdrs, *e = hdrs + n; p < e;) {
					const uint8_t *nl = memchr(p, '\n', e - p);
					if (!nl)
						nl = e;
					write_all(ofd, p, nl - p);
					write_all(ofd, "\r\n", 2);
					p = nl + 1;
				}
				write_all(ofd, "\r\n", 2);
			}
			break;
		}
		case RP_BODY:
			if (!head && write_all(ofd, r.p, r.end - r.p))
				die(23, "write failed");
			break;
		case RP_END:
			if (wfmt) {
				for (const char *p = wfmt; *p; p++) {
					if (!strncmp(p, "%{http_code}", 12)) { printf("%03u", status); p += 11; }
					else if (p[0] == '\\' && p[1] == 'n') { putchar('\n'); p++; }
					else putchar(*p);
				}
				fflush(stdout);
			}
			return fail_body && status >= 400 ? 22 : 0;
		case RP_ERR: {
			char *msg;
			rd_u32(&r);
			msg = rd_cstr(&r);
			die(7, msg);
		}
		}
		free(fr);
	}
}
