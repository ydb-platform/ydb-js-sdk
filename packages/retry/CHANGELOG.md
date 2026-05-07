# @ydbjs/retry

## 6.3.0

### Minor Changes

- [#599](https://github.com/ydb-platform/ydb-js-sdk/pull/599) [`b8b5ef5`](https://github.com/ydb-platform/ydb-js-sdk/commit/b8b5ef56b600cec4261680a5b211f4c2dd81259f) Thanks [@polRk](https://github.com/polRk)! - Publish retry-loop and per-attempt events on `node:diagnostics_channel`.

  New channels:
  - `tracing:ydb:retry.run` — span around the whole retry loop. Context: `{ idempotent }`.
  - `tracing:ydb:retry.attempt` — span around each attempt (numbered from 1). Context: `{ attempt, idempotent }`.
  - `ydb:retry.exhausted` — publish event when the loop exits without success. Payload: `{ attempts, totalDuration, lastError }`.

  Every consumer of `retry()` (driver discovery, query execution, transactions, auth token refresh) now produces a unified retry-span hierarchy automatically — no per-callsite imports needed.

  Channel names and payload fields are part of the public API. See `packages/retry/README.md` for the full table and a warning about safe subscribers.

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

## 6.2.0

### Minor Changes

- [`c6b7f26`](https://github.com/ydb-platform/ydb-js-sdk/commit/c6b7f266959f27e10effc7d94771e1a64ab79cfa) Thanks [@polRk](https://github.com/polRk)! - Fix memory leak in retry loop caused by `AbortSignal.any()`

  `AbortSignal.any()` registers event listeners on all source signals but never removes them, leading to a listener leak on every retry attempt. Replace it with `linkSignals` from `@ydbjs/abortable@^6.1.0`, which uses `Symbol.dispose` to clean up listeners immediately after each attempt via `using`.

  Additional correctness fixes in the same loop:
  - Fix order of `ctx.error` / `ctx.attempt` updates so error is recorded before incrementing attempt counter
  - Rename local `retry` variable to `willRetry` to avoid shadowing the outer function name
  - Pass the composed `signal` (instead of raw `cfg.signal`) to `setTimeout` so abort is properly respected during the inter-attempt delay
  - Fix oxlint directive from `disable` to `disable-next-line` to suppress only the intended line

## 6.1.1

### Patch Changes

- [#568](https://github.com/ydb-platform/ydb-js-sdk/pull/568) [`fbf2c6b`](https://github.com/ydb-platform/ydb-js-sdk/commit/fbf2c6bbd4b04da8d34d4e76c5d36b4dffb68dd9) Thanks [@DanilTezin](https://github.com/DanilTezin)! - Fix TimeoutOverflowWarning caused by unbounded exponential backoff. Replace `exponential(ms)` with `backoff(base, max)` which caps the delay via `Math.min(2^attempt * base, max)`, preventing `Infinity` from being passed to `setTimeout`.

## 6.1.0

### Minor Changes

- [#560](https://github.com/ydb-platform/ydb-js-sdk/pull/560) [`9123c13`](https://github.com/ydb-platform/ydb-js-sdk/commit/9123c13199871cb994ce146ccc2e83c2edf10399) Thanks [@polRk](https://github.com/polRk)! - Fix topic reader/writer disconnecting after Discovery.listEndpoints

  When the driver refreshed its endpoint pool on a periodic discovery round,
  it closed and recreated gRPC channels for all known nodes. This caused active
  bidirectional streams (topic reader / writer) to receive a `CANCELLED` gRPC
  status, which was not treated as a retryable error — so the streams terminated
  instead of reconnecting.

  Changes:
  - **`@ydbjs/retry`**: added `isRetryableStreamError` and `defaultStreamRetryConfig`.
    Long-lived streaming RPCs should reconnect on `CANCELLED` and `UNAVAILABLE`
    in addition to the errors already handled by `isRetryableError`, because for
    streams those codes indicate a transport interruption rather than a semantic
    cancellation.
  - **`@ydbjs/topic`**: reader (`_consume_stream`) and both writers (`writer`,
    `writer2`) now use `isRetryableStreamError` / `defaultStreamRetryConfig` so
    they transparently reconnect after a discovery-triggered channel replacement.
    Fixed a zombie-reader bug where `read()` would block forever if the retry
    budget was exhausted: the reader is now destroyed on unrecoverable stream
    errors so pending `read()` calls are unblocked immediately.

## 6.0.5

### Patch Changes

- Reduce npm package size by limiting published files to dist, README.md, and CHANGELOG.md only
- Updated dependencies
  - @ydbjs/abortable@6.0.5
  - @ydbjs/api@6.0.5
  - @ydbjs/debug@6.0.5
  - @ydbjs/error@6.0.5

## 6.0.4

### Patch Changes

- cb0db2f: Update dependencies
- Updated dependencies [cb0db2f]
  - @ydbjs/debug@6.0.4
  - @ydbjs/error@6.0.4
  - @ydbjs/api@6.0.4
  - @ydbjs/abortable@6.0.4

## 6.0.3

### Patch Changes

- @ydbjs/abortable@6.0.3
- @ydbjs/api@6.0.3
- @ydbjs/debug@6.0.3
- @ydbjs/error@6.0.3

## 6.0.2

### Patch Changes

- @ydbjs/abortable@6.0.2
- @ydbjs/api@6.0.2
- @ydbjs/debug@6.0.2
- @ydbjs/error@6.0.2

## 6.0.1

### Patch Changes

- @ydbjs/abortable@6.0.1
- @ydbjs/api@6.0.1
- @ydbjs/debug@6.0.1
- @ydbjs/error@6.0.1
