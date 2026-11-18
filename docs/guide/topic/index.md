---
title: Topic — Overview
---

# Topic (packages/topic)

Clients for YDB Topics: streaming read/write, offsets, codecs, transactions.

## Quick start

```ts
import { Driver } from '@ydbjs/core'
import { topic } from '@ydbjs/topic'

using driver = new Driver(process.env['YDB_CONNECTION_STRING']!)
await driver.ready()

let t = topic(driver)
await using reader = t.createReader({ topic: '/Root/my-topic', consumer: 'c1' })
for await (let batch of reader.read()) {
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
await using reader = t.createReader({
  topic: '/Root/my-topic',
  consumer: 'svc-a',
})

for await (let batch of reader.read({ limit: 100, batchWindowMs: 1000 })) {
  if (!batch.length) {
    continue
  }

  // process batch
  await reader.commit(batch)
}
```

### Custom codecs (gzip) {#examples-codecs}

```ts
import { Codec } from '@ydbjs/api/topic'
import * as zlib from 'node:zlib'

let MyGzip = {
  codec: Codec.GZIP,
  compress(payload: Uint8Array) {
    return zlib.gzipSync(payload)
  },
  decompress(payload: Uint8Array) {
    return zlib.gunzipSync(payload)
  },
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
import { createTopicTxReader } from '@ydbjs/topic/reader'
import { createTopicTxWriter } from '@ydbjs/topic/writer'

await using sql = query(driver)
await sql.begin(async (tx, signal) => {
  let reader = createTopicTxReader(tx, driver, {
    topic: '/Root/my-topic',
    consumer: 'svc-a',
  })

  for await (let batch of reader.read({ limit: 100, batchWindowMs: 1000, signal })) {
    // inside tx
    break
  }

  let writer = createTopicTxWriter(tx, driver, {
    topic: '/Root/my-topic',
    producer: 'p1',
  })

  writer.write(new TextEncoder().encode('in-tx'))
})
```

### Writer acks and seqNo {#examples-acks}

```ts
await using writer = t.createWriter({
  topic: '/Root/my-topic',
  producer: 'p1',
  onAck(seqNo, status) {
    console.log('ack', seqNo, status)
  },
})
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

for await (let batch of reader.read({ batchWindowMs: 500 })) {
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
    // Observes acknowledgments; commit() still needs error handling.
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
for await (let batch of reader.read({ batchWindowMs: 500 })) {
  // process recent events only
}
```

### Graceful shutdown {#examples-shutdown}

```ts
await reader.close() // waits for pending commits with a guard timeout
await writer.close() // flushes buffered messages and waits for inflight acks
```
