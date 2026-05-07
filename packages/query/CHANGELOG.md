# @ydbjs/query

## 6.2.0

### Minor Changes

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

- [#599](https://github.com/ydb-platform/ydb-js-sdk/pull/599) [`be55d0c`](https://github.com/ydb-platform/ydb-js-sdk/commit/be55d0cfe8cd182ed1c0aa58be53687f4587d92d) Thanks [@polRk](https://github.com/polRk)! - Publish query, transaction, and session-pool events on `node:diagnostics_channel`.

  New channels:
  - `tracing:ydb:query.execute` — span around a single `ExecuteQuery` RPC. Context: `{ text, sessionId, nodeId, idempotent, isolation, stage }`. `stage` is `'standalone' | 'tx' | 'do'`.
  - `tracing:ydb:query.transaction` — span around `tx.begin` → `commit`/`rollback` including retries. Context: `{ isolation, idempotent }`.
  - `tracing:ydb:session.acquire` — span around `pool.acquire()`. Context: `{ kind: 'query' | 'transaction' }`.
  - `tracing:ydb:session.create` — span around `Session.open()` when the pool grows. Context: `{ liveSessions, maxSize, creating }`.
  - `ydb:session.created` — `{ sessionId, nodeId }`.
  - `ydb:session.closed` — `{ sessionId, nodeId, reason, uptime }` with `reason: 'evicted' | 'pool_close'`. Fires exactly once per session, replacing the previous pair of `evicted` + `destroyed` events (which could double-fire on `pool.close()`).

  Retry-loop spans (`tracing:ydb:retry.*`) come from `@ydbjs/retry` and nest under `query.transaction` / `query.execute` via `AsyncLocalStorage` propagation — no per-callsite retry channel imports needed.

  Channel names, payload fields, and the `stage` / `reason` / `kind` enums are part of the public API. See `packages/query/README.md` for the full contract and a warning about safe subscribers.

### Patch Changes

- Updated dependencies [[`efa7adf`](https://github.com/ydb-platform/ydb-js-sdk/commit/efa7adf9e1346388a4358f3e1bf8a8ac5c85419b), [`fa32650`](https://github.com/ydb-platform/ydb-js-sdk/commit/fa32650b5393052e5802126f114355b9d3720448), [`b8b5ef5`](https://github.com/ydb-platform/ydb-js-sdk/commit/b8b5ef56b600cec4261680a5b211f4c2dd81259f)]:
  - @ydbjs/core@6.2.0
  - @ydbjs/retry@6.3.0

## 6.1.0

### Minor Changes

- [#589](https://github.com/ydb-platform/ydb-js-sdk/pull/589) [`9e79fca`](https://github.com/ydb-platform/ydb-js-sdk/commit/9e79fca524cd3912a8a5611ad2f2e1c430e0dddf) Thanks [@polRk](https://github.com/polRk)! - Add session pool for query service

  Sessions are now pooled and reused across queries and transactions instead of being created per-operation. Acquired sessions are handed out as disposable leases (`using`), so they return to the pool automatically at the end of the scope — including on thrown errors and mid-retry aborts.

  Pool behavior:
  - Bounded size (default `maxSize: 50`) with a FIFO waiter queue capped at `maxSize * waitQueueFactor` (default 8); over-cap callers get `SessionPoolFullError` instead of queueing unbounded.
  - LIFO reuse of idle sessions to keep the hot set warm and let cold sessions age out.
  - Server-side eviction frees the slot for the oldest waiter rather than rejecting the whole wait queue.
  - `close()` waits for in-flight session creation to finish, so late-completing creates don't land in a closed pool.

  Session lifecycle:
  - `Session.open` creates the server-side session and binds the `attachSession` keepalive atomically; on attach failure the server-side session is deleted before the error surfaces, so no sessions leak on the error path.
  - A single `AbortSignal` on the session (and mirrored per-lease) drives cancellation — in-flight operations abort automatically when the session dies.
  - Retries acquire a fresh lease per attempt and the transaction context is attempt-scoped, so a dead session no longer poisons subsequent retry attempts. The caller's `idempotent` flag is honored end-to-end.

  Configure via `query(driver, { poolOptions: { maxSize: 100, waitQueueFactor: 8 } })`.

### Patch Changes

- Updated dependencies [[`b2bf87d`](https://github.com/ydb-platform/ydb-js-sdk/commit/b2bf87d72ebbd8b7028e2c831f354f2a40f99fa9), [`5c54025`](https://github.com/ydb-platform/ydb-js-sdk/commit/5c54025de89a475f6cdbb81308c9dd106224e33a)]:
  - @ydbjs/value@6.0.6
  - @ydbjs/core@6.1.1

## 6.0.7

### Patch Changes

- Fix discovery client undefined check

- Updated dependencies []:
  - @ydbjs/core@6.0.7

## 6.0.6

### Patch Changes

- Fix memory leaks in Driver class

- Updated dependencies []:
  - @ydbjs/core@6.0.6

## 6.0.5

### Patch Changes

- Reduce npm package size by limiting published files to dist, README.md, and CHANGELOG.md only
- Updated dependencies
  - @ydbjs/api@6.0.5
  - @ydbjs/core@6.0.5
  - @ydbjs/debug@6.0.5
  - @ydbjs/error@6.0.5
  - @ydbjs/retry@6.0.5
  - @ydbjs/value@6.0.5

## 6.0.4

### Patch Changes

- cb0db2f: Update dependencies
- Updated dependencies [cb0db2f]
  - @ydbjs/debug@6.0.4
  - @ydbjs/error@6.0.4
  - @ydbjs/retry@6.0.4
  - @ydbjs/value@6.0.4
  - @ydbjs/core@6.0.4
  - @ydbjs/api@6.0.4

## 6.0.3

### Patch Changes

- @ydbjs/api@6.0.3
- @ydbjs/core@6.0.3
- @ydbjs/debug@6.0.3
- @ydbjs/error@6.0.3
- @ydbjs/retry@6.0.3
- @ydbjs/value@6.0.3

## 6.0.2

### Patch Changes

- Export type Query from query client
  - @ydbjs/api@6.0.2
  - @ydbjs/core@6.0.2
  - @ydbjs/debug@6.0.2
  - @ydbjs/error@6.0.2
  - @ydbjs/retry@6.0.2
  - @ydbjs/value@6.0.2

## 6.0.1

### Patch Changes

- @ydbjs/api@6.0.1
- @ydbjs/core@6.0.1
- @ydbjs/debug@6.0.1
- @ydbjs/error@6.0.1
- @ydbjs/retry@6.0.1
- @ydbjs/value@6.0.1
