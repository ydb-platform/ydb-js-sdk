---
title: Topic — Transactions
---

# Topic Transactions

Integrating message read/write with `@ydbjs/query` transactions.

## Example

```ts
import { query } from '@ydbjs/query'
import { createTopicTxReader } from '@ydbjs/topic/reader'
import { createTopicTxWriter } from '@ydbjs/topic/writer'

await using sql = query(driver)

await sql.transaction(async (tx, signal) => {
  // IMPORTANT: do not use `using` in a transaction.
  // Reader/Writer are managed by transaction hooks and shut down automatically.
  let reader = createTopicTxReader(tx, driver, {
    topic: '/Root/my-topic',
    consumer: 'c1',
  })

  for await (let batch of reader.read({ limit: 100, batchWindowMs: 1000, signal })) {
    // processing
    break
  }

  let writer = createTopicTxWriter(tx, driver, {
    topic: '/Root/my-topic',
    producer: 'p1',
  })

  writer.write(new TextEncoder().encode('message'))
  // Do not close explicitly — writer flushes on onCommit
})
```

Note: TopicTxReader registers offset updates in `tx.onCommit`, TopicTxWriter drains accepted writes with `close(signal)` in `tx.onCommit`. The reader closes after registering offsets; rollback and uncommitted close destroy remaining work. Manual `close()/destroy()` or `using` inside the transaction body is unnecessary and may interfere with commit.
