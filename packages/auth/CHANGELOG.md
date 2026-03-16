# @ydbjs/auth

## 6.2.1

### Patch Changes

- [`9f556fe`](https://github.com/ydb-platform/ydb-js-sdk/commit/9f556fe80527a136e23ad5ff70279545f533c0a6) Thanks [@polRk](https://github.com/polRk)! - Fix `StaticCredentialsProvider` background token refresh being immediately cancelled

  `#refreshTokenInBackground` previously used `void this.#refreshToken(linkedSignal.signal)` — fire-and-forget, so `using linkedSignal` stayed alive for the duration of the refresh. After the fix for the memory leak the call became `await this.#refreshToken(...)`, which caused `[Symbol.dispose]` to run synchronously at the end of the `async` function frame — before the refresh had a chance to complete — aborting the underlying `AbortController` and cancelling every background refresh immediately.

## 6.2.0

### Minor Changes

- [`01777e2`](https://github.com/ydb-platform/ydb-js-sdk/commit/01777e2baa7ea0f0774392db3232ae63e29bbf3c) Thanks [@polRk](https://github.com/polRk)! - Fix memory leak in background token refresh caused by `AbortSignal.any()`

  `AbortSignal.any()` registers event listeners on source signals but never removes them, causing a listener leak each time background token refresh is started. Replace it with `linkSignals` from `@ydbjs/abortable@^6.1.0`, which uses `Symbol.dispose` to clean up listeners when the refresh loop exits.

  Additional fixes:
  - Pass `signal` from the retry callback into `#client.login()` so the login RPC is properly cancelled on abort instead of running unchecked
  - Update `@ydbjs/retry` dependency to `^6.2.0` to pick up the same signal-handling fixes in the retry loop

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
