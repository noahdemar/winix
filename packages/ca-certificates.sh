# Mozilla's root certificates, as published by curl (https://curl.se/docs/caextract.html). Sourced by
# scripts/build-packages.sh. OpenSSL in the guest (packages/openssl.inc) reads /etc/ssl/cert.pem.
NAME=ca-certificates
VERSION=2026.09.25
DEPS=-
DESC="Mozilla CA certificate bundle (/etc/ssl/cert.pem), for TLS in guest programs"
URL=https://curl.se/ca/cacert-2026-09-25.pem
SHA256=a41b5d356aea97a529fe27e0f7316d2f9d946d75927476cf9cf1b90637d00505

build() {
	mkdir -p "$DEST/etc/ssl/certs"
	fetch "$URL" "$SHA256" "$DEST/etc/ssl/cert.pem" || return 1
	ln -s ../cert.pem "$DEST/etc/ssl/certs/ca-certificates.crt"
}
