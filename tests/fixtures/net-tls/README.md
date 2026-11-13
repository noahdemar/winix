Test-only certificates for `tests/net.mjs`: `ca.pem` is a throwaway CA (its key was deleted after signing) and
`server.pem`/`server.key` are a `localhost`/`127.0.0.1` certificate it signed, valid until 2046. Never trust these
anywhere else.
