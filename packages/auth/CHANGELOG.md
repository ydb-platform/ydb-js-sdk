# @ydbjs/auth

## 6.1.0

### Minor Changes

- [#564](https://github.com/ydb-platform/ydb-js-sdk/pull/564) [`66d69bc`](https://github.com/ydb-platform/ydb-js-sdk/commit/66d69bcc44f4473dfc124ad6fb9cec7a0759b3c7) Thanks [@polRk](https://github.com/polRk)! - Add EnvironCredentialsProvider that auto-detects authentication method from environment variables (YDB_ANONYMOUS_CREDENTIALS, YDB_METADATA_CREDENTIALS, YDB_ACCESS_TOKEN_CREDENTIALS, YDB_STATIC_CREDENTIALS_USER) and TLS configuration (YDB_SSL_ROOT_CERTIFICATES_FILE, YDB_SSL_CERTIFICATE_FILE, YDB_SSL_PRIVATE_KEY_FILE or their PEM string variants). Exported from `@ydbjs/auth/environ`.

## 6.0.5

### Patch Changes

- Reduce npm package size by limiting published files to dist, README.md, and CHANGELOG.md only
- Updated dependencies
  - @ydbjs/api@6.0.5
  - @ydbjs/debug@6.0.5
  - @ydbjs/error@6.0.5
  - @ydbjs/retry@6.0.5

## 6.0.4

### Patch Changes

- cb0db2f: Update dependencies
- Updated dependencies [cb0db2f]
  - @ydbjs/debug@6.0.4
  - @ydbjs/error@6.0.4
  - @ydbjs/retry@6.0.4
  - @ydbjs/api@6.0.4

## 6.0.3

### Patch Changes

- @ydbjs/api@6.0.3
- @ydbjs/debug@6.0.3
- @ydbjs/error@6.0.3
- @ydbjs/retry@6.0.3

## 6.0.2

### Patch Changes

- @ydbjs/api@6.0.2
- @ydbjs/debug@6.0.2
- @ydbjs/error@6.0.2
- @ydbjs/retry@6.0.2

## 6.0.1

### Patch Changes

- @ydbjs/api@6.0.1
- @ydbjs/debug@6.0.1
- @ydbjs/error@6.0.1
- @ydbjs/retry@6.0.1
