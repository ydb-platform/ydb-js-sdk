---
title: Query — Transactions
---

# Transactions in Query

`@ydbjs/query` provides two helpers: `begin` and `transaction`.

- `begin(options?, fn)` — creates a transaction, runs `fn(tx, signal)`, commits on success and attempts rollback on error.
- `transaction(options?, fn)` — alias to `begin`.

Options:

- `isolation?: 'serializableReadWrite' | 'snapshotReadOnly' | 'snapshotReadWrite'` — isolation level (default `serializableReadWrite`).
- `idempotent?: boolean` — enables retries for conditionally retryable errors. Ensure business logic is idempotent.

Options also include `signal`, `timeout`, `retry: { budget, strategy }` and `onRetry`.
The second callback argument is the current attempt's signal; pass it to asynchronous application work.

The entire callback can repeat, including with `idempotent: false` after definite-abort failures.
Create per-attempt state inside the callback and account for repeated external effects.
The tagged API's `onCommit()` runs before the commit RPC; the equivalent hook in `QueryClient.retryTransaction()` is named `beforeCommit()`.
Cancellation or a lost response does not prove rollback.
A cleanup failure after confirmed commit becomes `TransactionCompletionError` with `committed: true` and the original error in `cause`; SDK retries treat it as terminal.

## Basic usage

```ts
let result = await sql.begin(async (tx) => {
  await tx`UPDATE users SET active = false WHERE id = ${42}`
  return await tx`SELECT * FROM users WHERE active = false`
})
```

## Isolation and idempotency options

```ts
await sql.begin(
  {
    isolation: 'snapshotReadOnly',
    idempotent: true,
  },
  async (tx) => {
    return await tx`SELECT COUNT(*) FROM users`
  }
)
```

## Topic integration (without using)

When inside `sql.transaction(...)`, use tx‑aware Topic clients without `using`/manual disposal:

```ts
import { createTopicTxReader } from '@ydbjs/topic/reader'
import { createTopicTxWriter } from '@ydbjs/topic/writer'

await sql.transaction({ signal: AbortSignal.timeout(10_000) }, async (tx, signal) => {
  let reader = createTopicTxReader(tx, driver, {
    topic: '/Root/input-topic',
    consumer: 'svc-a',
  })
  let writer = createTopicTxWriter(tx, driver, {
    topic: '/Root/output-topic',
    producer: 'p1',
  })

  for await (let batch of reader.read({ limit: 1, signal })) {
    if (batch.length === 0) {
      continue
    }

    for (let message of batch) {
      writer.write(message.payload)
    }

    break
  }
})
```

The example moves one message between existing topics; the input topic needs the `svc-a` consumer. `limit` caps one batch; the explicit `break` after a non-empty batch ends reading so the callback can proceed to commit. If no message arrives before the deadline, the operation fails.

The Reader binds delivered offsets to the transaction and closes in `tx.onCommit`; the Writer drains pending writes through `close()` in the same hook. Cleanup hooks handle failure. Manual disposal inside the callback is not required.

## Timeouts and retries

- Set timeouts per query or per handler.
- See “Advanced → Retries and Idempotency”.

## Best practices

- Keep transactions short to reduce blocking/conflicts.
- Prefer `snapshotReadOnly` for read‑only operations when possible.
- Idempotent operations make retries easier; use idempotency keys if needed.
- Avoid mixing heavy Topic operations with large SQL reads in a single transaction unless necessary.
