# @ydbjs/auth

## 6.3.0

### Minor Changes

- [#599](https://github.com/ydb-platform/ydb-js-sdk/pull/599) [`c388ccc`](https://github.com/ydb-platform/ydb-js-sdk/commit/c388cccef45a6f5c6ba325df7f80d9b8337b156b) Thanks [@polRk](https://github.com/polRk)! - Publish credentials-provider events on `node:diagnostics_channel`.

  New channels:
  - `tracing:ydb:auth.token.fetch` — span around the full token fetch, including retries. Context: `{ provider }`.
  - `ydb:auth.token.refreshed` — `{ provider, expiresAt }` (unix ms). Single, monotonic timestamp instead of per-provider `expiresIn` semantics.
  - `ydb:auth.token.expired` — `{ provider, stalenessMs }`. Fires once per expiration incident, not per call.
  - `ydb:auth.provider.failed` — `{ provider, error }`. Fires after all retries are exhausted.

  `provider` is an open string set. Built-in values: `'static'`, `'metadata'`, plus values contributed by external providers (e.g. `'yc-service-account'` from `@ydbjs/auth-yandex-cloud`). Custom `CredentialsProvider` implementations should mint a stable, namespaced provider id.

  Channel names and payload fields are part of the public API. See `packages/auth/README.md` for the full contract and a warning about safe subscribers.

### Patch Changes

- [#599](https://github.com/ydb-platform/ydb-js-sdk/pull/599) [`fa32650`](https://github.com/ydb-platform/ydb-js-sdk/commit/fa32650b5393052e5802126f114355b9d3720448) Thanks [@polRk](https://github.com/polRk)! - Follow-ups to the `node:diagnostics_channel` instrumentation:

  `@ydbjs/query` — new tracing channels around transaction control RPCs:
  - `tracing:ydb:query.begin` — `BeginTransaction`. Context: `{ sessionId, nodeId, isolation }`.
  - `tracing:ydb:query.commit` — `CommitTransaction`. Context: `{ sessionId, nodeId, txId }`.
  - `tracing:ydb:query.rollback` — `RollbackTransaction`. Context: `{ sessionId, nodeId, txId }`. Fire-and-forget — `start` always fires, `asyncEnd` may land after the surrounding `query.transaction.error`.

  `tracing:ydb:query.execute` is reserved for `ExecuteQuery` RPCs only; subscribers building per-statement metrics should not expect `query.execute` events for begin/commit/rollback.

  Bug fixes:
  - `@ydbjs/query` — releasing a checked-out session after `pool.close()` no longer publishes `ydb:session.closed` twice. The eviction listener is detached before `session.close()` fires its abort.
  - `@ydbjs/core` — `Driver.close()` now cancels in-flight discovery and rejects pending `ready()` waiters. `ydb:driver.ready` / `ydb:driver.failed` no longer fire after `ydb:driver.closed`.
  - `@ydbjs/core` — `pool.pessimize()` only publishes `ydb:pool.connection.pessimized` (and calls the `onPessimize` hook) on the active→pessimized transition. Repeated pessimize calls that just refresh the timeout are now silent, so subscribers reconstructing pool state from delta events don't see phantom transitions.

  Documentation contract clarifications (no behavior change, but subscribers built from the previous wording were wrong):
  - `@ydbjs/retry` — `tracing:ydb:retry.attempt.error` fires for **every** failed attempt, including the final non-retried one. The README previously implied it fires only for attempts that will be retried.
  - `@ydbjs/auth` — the `provider` field is an open string set (custom `CredentialsProvider` implementations may contribute new values), not an enum. Subscribers should treat it as a label rather than write exhaustive switches.

- Updated dependencies [[`fa32650`](https://github.com/ydb-platform/ydb-js-sdk/commit/fa32650b5393052e5802126f114355b9d3720448), [`b8b5ef5`](https://github.com/ydb-platform/ydb-js-sdk/commit/b8b5ef56b600cec4261680a5b211f4c2dd81259f)]:
  - @ydbjs/retry@6.3.0

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
