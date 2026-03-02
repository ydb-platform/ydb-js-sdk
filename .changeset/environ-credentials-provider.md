---
'@ydbjs/auth': minor
---

Add EnvironCredentialsProvider that auto-detects authentication method from environment variables (YDB_ANONYMOUS_CREDENTIALS, YDB_METADATA_CREDENTIALS, YDB_ACCESS_TOKEN_CREDENTIALS, YDB_STATIC_CREDENTIALS_USER) and TLS configuration (YDB_SSL_ROOT_CERTIFICATES_FILE, YDB_SSL_CERTIFICATE_FILE, YDB_SSL_PRIVATE_KEY_FILE or their PEM string variants). Exported from `@ydbjs/auth/environ`.
