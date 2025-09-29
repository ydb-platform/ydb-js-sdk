---
title: Error Handling
---

# Error Handling

This guide outlines error classes and handling patterns used by the SDK.

## Error classes

- `YDBError` — server-side YDB error with `code` and `issues`.
- `CommitError` — commit failed; exposes `retryable(idempotent)`.
- `ClientError` — gRPC client-side error (e.g., `UNAVAILABLE`).

Use `instanceof` checks to branch logic.

```ts
import { YDBError } from '@ydbjs/error'

try {
  await sql`SELECT * FROM t`
} catch (e) {
  if (e instanceof YDBError) {
    console.error('YDB code:', e.code)
  }
  throw e
}
```

## Query stats for diagnostics

```ts
import { StatsMode } from '@ydbjs/api/query'

const q = sql`SELECT * FROM t`.withStats(StatsMode.FULL)
q.on('stats', (s) => console.log('cpu(us)=', s.queryPhaseStats?.cpuTimeUs))
await q
```

## Timeouts and cancellations

Compose `AbortSignal` across the stack. Prefer per-call `.timeout(ms)` and provide external `signal` when orchestrating multiple operations.

## Logging and debugging

Enable debug logs to trace failures: `DEBUG=ydbjs:*`. See Advanced → Debug Logging.

## Retries

Use `.idempotent(true)` for safe single-call retries and ensure business logic can be replayed. See Advanced → Retries.
