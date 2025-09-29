---
title: Query — Transactions
---

# Transactions in Query

`@ydbjs/query` provides two helpers: `begin` and `transaction`.

- `begin(options?, fn)` — creates a transaction, runs `fn(tx, signal)`, commits on success and rolls back on error.
- `transaction(options?, fn)` — alias to `begin`.

Options:
- `isolation?: 'serializableReadWrite' | 'snapshotReadOnly'` — isolation level (default `serializableReadWrite`).
- `idempotent?: boolean` — enables retries for conditionally retryable errors. Ensure business logic is idempotent.

`signal: AbortSignal` allows canceling long operations inside the callback.

## Basic usage

```ts
const result = await sql.begin(async (tx) => {
  await tx`UPDATE users SET active = false WHERE ...`
  return await tx`SELECT * FROM users WHERE active = false`
})
```

## Isolation and idempotency options

```ts
await sql.begin({ isolation: 'snapshotReadOnly', idempotent: true }, async (tx) => {
  return await tx`SELECT COUNT(*) FROM users`
})
```

## Topic integration (without using)

When inside `sql.transaction(...)`, use tx‑aware Topic clients without `using`/manual disposal:

```ts
import { createTopicTxReader } from '@ydbjs/topic/reader'
import { createTopicTxWriter } from '@ydbjs/topic/writer'

await sql.transaction(async (tx, signal) => {
  const reader = createTopicTxReader(tx, driver, { topic: '/Root/my-topic', consumer: 'svc-a' })
  for await (const batch of reader.read({ signal })) {
    // processing
  }

  const writer = createTopicTxWriter(tx, driver, { topic: '/Root/my-topic', producer: 'p1' })
  writer.write(new TextEncoder().encode('message'))
})
```

Reader registers `updateOffsetsInTransaction` on `tx.onCommit`; Writer triggers `flush` on `tx.onCommit`. Manual disposal inside a transaction is not required.

## Timeouts and retries

- Set timeouts per query or per handler.
- See “Advanced → Retries and Idempotency”.

## Best practices

- Keep transactions short to reduce blocking/conflicts.
- Prefer `snapshotReadOnly` for read‑only operations when possible.
- Idempotent operations make retries easier; use idempotency keys if needed.
- Avoid mixing heavy Topic operations with large SQL reads in a single transaction unless necessary.
