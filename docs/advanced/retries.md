---
title: Retries and Idempotency
---

# Retries and Idempotency

This guide explains how retries work in the SDK and when to enable idempotency.

## Retry policy overview

Retries are powered by `@ydbjs/retry` with sensible defaults:

- Immediate retry for `BAD_SESSION`, `SESSION_EXPIRED`, `ABORTED`.
- Exponential backoff for `OVERLOADED` and gRPC `RESOURCE_EXHAUSTED` (starts at 1000 ms).
- Exponential backoff for all other retryable cases (starts at 10 ms).
- Budget is unlimited by default; pass `budget` to cap attempts.

Query retries depend on the idempotency flag:

- Always retried: `ABORTED`, `OVERLOADED`, `UNAVAILABLE`, `BAD_SESSION`, `SESSION_BUSY`.
- Conditionally retried (only with `.idempotent(true)`): `SESSION_EXPIRED`, `UNDETERMINED`, `TIMEOUT`.

See implementation: `packages/retry/src/index.ts` and `packages/query/src/query.ts`.

## Marking single calls as idempotent

```ts
await sql`UPDATE counters SET v = v + 1 WHERE id = ${id}`
  .idempotent(true)
  .timeout(3000)
```

Inside `sql.begin`/`sql.transaction`, the per-call idempotency flag is ignored; configure idempotency at the transaction level and make your business logic idempotent (e.g., via idempotency keys).

## Customizing retry strategy

```ts
import { retry, defaultRetryConfig, strategies } from '@ydbjs/retry'

await retry({
  ...defaultRetryConfig,
  budget: 5,
  strategy: strategies.exponential(200),
}, async (signal) => {
  return await sql`SELECT 1`.signal(signal)
})
```

## Topic streaming

Topic readers/writers reconnect on failures and rebuild command queues. Use `retryConfig` on writer for fine tuning; keep producers idempotent with `producerId + seqNo`.

## Best practices

- Prefer idempotent operations and use idempotency keys for at-least-once flows.
- Set explicit timeouts to constrain tail latencies.
- Log retries via `on('retry')` and enable `DEBUG=ydbjs:*` in staging.
