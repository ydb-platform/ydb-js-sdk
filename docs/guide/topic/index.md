---
title: Topic — Overview
---

# Topic (packages/topic)

Clients for YDB Topics: streaming read/write, offsets, codecs, transactions.

## Quick start

```ts
import { Driver } from '@ydbjs/core'
import { topic } from '@ydbjs/topic'

const driver = new Driver(process.env['YDB_CONNECTION_STRING']!)
await driver.ready()

const t = topic(driver)
await using reader = t.createReader({ topic: '/Root/my-topic', consumer: 'c1' })
for await (const batch of reader.read()) {
  await reader.commit(batch)
}
```

## Writer

```ts
await using writer = t.createWriter({ topic: '/Root/my-topic', producer: 'p1' })
writer.write(new TextEncoder().encode('Hello'))
await writer.flush()
```

## Examples {#examples}

### Reader with batching and timeouts {#examples-reader-batching}

```ts
await using reader = t.createReader({ topic: '/Root/my-topic', consumer: 'svc-a' })
for await (const batch of reader.read({ limit: 100, waitMs: 1000 })) {
  if (!batch.length) continue // periodic tick without blocking the loop
  // process batch
  void reader.commit(batch) // fire-and-forget with onCommittedOffset hook
}
```

### Custom codecs (gzip) {#examples-codecs}

```ts
import { Codec } from '@ydbjs/api/topic'
import * as zlib from 'node:zlib'

const MyGzip = {
  codec: Codec.GZIP,
  compress: (p: Uint8Array) => zlib.gzipSync(p),
  decompress: (p: Uint8Array) => zlib.gunzipSync(p),
}

await using reader = t.createReader({
  topic: '/Root/custom',
  consumer: 'svc-a',
  codecMap: new Map([[Codec.GZIP, MyGzip]]),
})
```

### Transactional reader/writer {#examples-tx}

```ts
import { query } from '@ydbjs/query'
import { createTopicTxReader, createTopicTxWriter } from '@ydbjs/topic'

const sql = query(driver)
await sql.begin(async (tx, signal) => {
  const reader = createTopicTxReader(tx, driver, { topic: '/Root/my-topic', consumer: 'svc-a' })
  for await (const batch of reader.read({ signal })) {
    // inside tx
  }

  const writer = createTopicTxWriter(tx, driver, { topic: '/Root/my-topic', producer: 'p1' })
  writer.write(new TextEncoder().encode('in-tx'))
})
```

### Writer acks and seqNo {#examples-acks}

```ts
await using writer = t.createWriter({ topic: '/Root/my-topic', producer: 'p1' })
writer.onAck = (seqNo, status) => console.log('ack', seqNo, status)
writer.write(new TextEncoder().encode('hello'))
await writer.flush()
```

### Payload size and inflight limits {#examples-limits}

```ts
// Internally, a single message > 48MiB will be rejected by Topic client
// Split large payloads or compress via codecs
```

### Multiple sources and partition filters {#examples-sources}

```ts
await using reader = t.createReader({
  topic: [{ path: '/Root/topic-a', partitionIds: [0n, 1n] }, { path: '/Root/topic-b' }],
  consumer: 'svc-a',
})
for await (const batch of reader.read({ waitMs: 500 })) {
  // process messages from both topics, filtered partitions
}
```

### Partition session hooks {#examples-hooks}

```ts
await using reader = t.createReader({
  topic: '/Root/metrics',
  consumer: 'svc-a',
  onPartitionSessionStart: async (session, committed, { start, end }) => {
    // shift readOffset to resume from the last committed
    return { readOffset: committed }
  },
  onPartitionSessionStop: async (session, committed) => {
    console.log('partition closed', session.partitionSessionId, 'committed', committed)
  },
  onCommittedOffset: (session, committed) => {
    // observe commits (useful with fire-and-forget commit())
    console.log('committed', session.partitionSessionId, committed)
  },
})
```

### Time-based selectors: readFrom and maxLag {#examples-time-selectors}

```ts
await using reader = t.createReader({
  topic: {
    path: '/Root/events',
    readFrom: new Date(Date.now() - 60_000), // last 1 min
    maxLag: '30s', // or number milliseconds
  },
  consumer: 'svc-a',
})
for await (const batch of reader.read({ waitMs: 500 })) {
  // process recent events only
}
```

### Graceful shutdown {#examples-shutdown}

```ts
await reader.close() // waits for pending commits with a guard timeout
await writer.close() // flushes buffered messages and waits for inflight acks
```
