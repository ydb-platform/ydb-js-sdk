---
'@ydbjs/query': minor
---

Add session pool for query service

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
