# @ydbjs/topic

Read this in Russian: [README.ru.md](README.ru.md)

High‑level, type‑safe clients for YDB Topics (publish–subscribe message streams) in JavaScript/TypeScript. Provides efficient streaming reads and writes, partition session management, offset commits, compression, and transaction‑aware readers/writers.

## Features

- Streaming reader and writer with async iteration
- Partition session lifecycle hooks and offset commit
- Pluggable compression codecs (RAW, GZIP, ZSTD; custom via maps)
- Transaction‑aware read/write helpers
- First‑class TypeScript types

## Installation

```sh
npm install @ydbjs/topic
```

Requires Node.js >= 20.19.

## Getting Started

Two ways to use the client:

- Top‑level client via `topic(driver)`
- Direct factory functions via subpath imports

### Using the top‑level client

```ts
import { Driver } from '@ydbjs/core'
import { topic } from '@ydbjs/topic'

const driver = new Driver(process.env['YDB_CONNECTION_STRING']!)
await driver.ready()

const t = topic(driver)

// Reader
await using reader = t.createReader({
  topic: '/Root/my-topic',
  consumer: 'my-consumer',
})
for await (const batch of reader.read()) {
  // Process messages
  for (const msg of batch) console.log(new TextDecoder().decode(msg.payload))
  // Commit processed offsets (see performance note below)
  await reader.commit(batch)
}

// Writer
await using writer = t.createWriter({
  topic: '/Root/my-topic',
  producer: 'my-producer',
})
writer.write(new TextEncoder().encode('Hello, YDB!'))
await writer.flush()
```

### Using direct factories

```ts
import { Driver } from '@ydbjs/core'
import { createTopicReader, createTopicTxReader } from '@ydbjs/topic/reader'
import { createTopicWriter, createTopicTxWriter } from '@ydbjs/topic/writer'

const driver = new Driver(process.env['YDB_CONNECTION_STRING']!)
await driver.ready()

await using reader = createTopicReader(driver, {
  topic: '/Root/my-topic',
  consumer: 'my-consumer',
})
await using writer = createTopicWriter(driver, {
  topic: '/Root/my-topic',
  producer: 'my-producer',
})
```

## Reader

### Options

- `topic`: `string | TopicReaderSource | TopicReaderSource[]` — topic path or detailed sources
- `consumer`: `string` — consumer name
- `codecMap?`: `Map<Codec | number, CompressionCodec>` — custom codecs for decompression
- `maxBufferBytes?`: `bigint` — internal buffer cap (default ~4 MiB)
- `updateTokenIntervalMs?`: `number` — auth token refresh interval (default 60000)
- `onPartitionSessionStart?`: hook to adjust read/commit offsets per session
- `onPartitionSessionStop?`: hook on session stop (cleanup/commit)
- `onCommittedOffset?`: observe commit acknowledgments from server

TopicReaderSource supports partition filters and time‑based selectors:

```ts
const source = {
  path: '/Root/my-topic',
  partitionIds: [0n, 1n],
  // Skip messages older than 5 minutes
  maxLag: '5m', // number (ms), ms‑string, or Duration
  // Start from a timestamp
  readFrom: new Date(Date.now() - 60_000),
}
```

### Reading and committing

```ts
const t = topic(driver)
await using reader = t.createReader({ topic: source, consumer: 'svc-a' })

for await (const batch of reader.read({ limit: 100, waitMs: 1000 })) {
  if (!batch.length) continue // periodic empty batches when no data

  // Handle messages
  for (const m of batch) doSomething(m)

  // Option A (simple): await commit for each batch
  await reader.commit(batch)

  // Option B (fast path): fire‑and‑forget commit
  // void reader.commit(batch)
}
```

Performance note: awaiting `commit()` in the hot path reduces throughput. For high load, prefer fire‑and‑forget plus `onCommittedOffset` to observe confirmations asynchronously.

## Writer

### Options

- `topic`: `string`
- `tx?`: `TX` — transaction to write within
- `producer?`: `string` — producer id (auto‑generated if omitted)
- `codec?`: `CompressionCodec` — compression (default RAW; built‑ins: RAW, GZIP, ZSTD)
- `maxBufferBytes?`: `bigint` — writer buffer cap (default 256 MiB)
- `maxInflightCount?`: `number` — max messages in‑flight (default 1000)
- `flushIntervalMs?`: `number` — periodic flush tick (default 10ms)
- `updateTokenIntervalMs?`: `number` — auth token refresh interval (default 60000)
- `retryConfig?(signal)`: tune connection retry strategy
- `onAck?(seqNo, status)`: callback on message acknowledgment

### Writing messages

```ts
import { Codec } from '@ydbjs/api/topic'

const t = topic(driver)
await using writer = t.createWriter({
  topic: '/Root/my-topic',
  producer: 'json-producer',
  // Use RAW by default, or provide your own codec implementation.
  // See "Custom codecs" below for an example.
  onAck(seqNo, status) {
    console.log('ack', seqNo, status)
  },
})

const payload = new TextEncoder().encode(
  JSON.stringify({ foo: 'bar', ts: Date.now() })
)
const seqNo = writer.write(payload)
await writer.flush()
```

`write()` accepts `Uint8Array` only. Encode your own objects/strings as needed.

## Transactions

Run topic reads/writes inside an @ydbjs/query transaction handler and pass the `tx` object that it provides. Do not use `using`/explicit close inside the transaction — TopicTxReader/Writer are wired to `tx` hooks and clean up automatically.

- Reader: `createTopicTxReader(tx, driver, { topic, consumer })` or `t.createTxReader(tx, { ... })`. The reader tracks read offsets and issues `updateOffsetsInTransaction` on commit.
- Writer: `createTopicTxWriter(tx, driver, { topic, ... })` or `t.createTxWriter(tx, { ... })`. The writer flushes before commit.

```ts
import { query } from '@ydbjs/query'
import { createTopicTxReader } from '@ydbjs/topic/reader'
import { createTopicTxWriter } from '@ydbjs/topic/writer'

const qc = query(driver)

await qc.transaction(async (tx, signal) => {
  const reader = createTopicTxReader(tx, driver, {
    topic: '/Root/my-topic',
    consumer: 'svc-a',
  })
  for await (const batch of reader.read({ signal })) {
    // process batch...
  }

  const writer = createTopicTxWriter(tx, driver, {
    topic: '/Root/my-topic',
    producer: 'p1',
  })
  writer.write(new TextEncoder().encode('message'))
  // writer waits for flush on tx.onCommit; no manual close required
})
```

Note: `tx` comes from the Query layer and exposes the required hooks; Topic clients integrate with them automatically.

## Custom codecs

Reader supports custom decompression through `codecMap` and writer via a `CompressionCodec` instance.

```ts
import { Codec } from '@ydbjs/api/topic'
import * as zlib from 'node:zlib'

const MyGzip = {
  codec: Codec.GZIP,
  compress: (p: Uint8Array) => zlib.gzipSync(p),
  decompress: (p: Uint8Array) => zlib.gunzipSync(p),
}

await using reader = createTopicReader(driver, {
  topic: '/Root/custom',
  consumer: 'c1',
  codecMap: new Map([[Codec.GZIP, MyGzip]]),
})

await using writer = createTopicWriter(driver, {
  topic: '/Root/custom',
  producer: 'p1',
  codec: MyGzip,
})
```

## Exports

- `@ydbjs/topic`: `topic(driver)` and types
- `@ydbjs/topic/reader`: `createTopicReader`, `createTopicTxReader`, reader types
- `@ydbjs/topic/writer`: `createTopicWriter`, `createTopicTxWriter`, writer types
- `@ydbjs/topic/writer2`: experimental state‑machine writer

## License

Apache-2.0
