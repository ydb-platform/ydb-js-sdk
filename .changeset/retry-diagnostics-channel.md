---
'@ydbjs/retry': minor
---

Publish retry-loop and per-attempt events on `node:diagnostics_channel`.

New channels:

- `tracing:ydb:retry.run` — span around the whole retry loop. Context: `{ idempotent }`.
- `tracing:ydb:retry.attempt` — span around each attempt (numbered from 1). Context: `{ attempt, idempotent }`.
- `ydb:retry.exhausted` — publish event when the loop exits without success. Payload: `{ attempts, totalDuration, lastError }`.

Every consumer of `retry()` (driver discovery, query execution, transactions, auth token refresh) now produces a unified retry-span hierarchy automatically — no per-callsite imports needed.

Channel names and payload fields are part of the public API. See `packages/retry/README.md` for the full table and a warning about safe subscribers.
