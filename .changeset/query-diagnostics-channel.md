---
'@ydbjs/query': minor
---

Publish query, transaction, and session-pool events on `node:diagnostics_channel`.

New channels:

- `tracing:ydb:query.execute` — span around a single `ExecuteQuery` RPC. Context: `{ text, sessionId, nodeId, idempotent, isolation, stage }`. `stage` is `'standalone' | 'tx' | 'do'`.
- `tracing:ydb:query.transaction` — span around `tx.begin` → `commit`/`rollback` including retries. Context: `{ isolation, idempotent }`.
- `tracing:ydb:session.acquire` — span around `pool.acquire()`. Context: `{ kind: 'query' | 'transaction' }`.
- `tracing:ydb:session.create` — span around `Session.open()` when the pool grows. Context: `{ liveSessions, maxSize, creating }`.
- `ydb:session.created` — `{ sessionId, nodeId }`.
- `ydb:session.closed` — `{ sessionId, nodeId, reason, uptime }` with `reason: 'evicted' | 'pool_close'`. Fires exactly once per session, replacing the previous pair of `evicted` + `destroyed` events (which could double-fire on `pool.close()`).

Retry-loop spans (`tracing:ydb:retry.*`) come from `@ydbjs/retry` and nest under `query.transaction` / `query.execute` via `AsyncLocalStorage` propagation — no per-callsite retry channel imports needed.

Channel names, payload fields, and the `stage` / `reason` / `kind` enums are part of the public API. See `packages/query/README.md` for the full contract and a warning about safe subscribers.
