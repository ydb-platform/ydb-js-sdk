---
'@ydbjs/query': minor
'@ydbjs/core': patch
'@ydbjs/retry': patch
'@ydbjs/auth': patch
---

Follow-ups to the `node:diagnostics_channel` instrumentation:

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
