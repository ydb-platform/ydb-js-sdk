# @ydbjs/topic

[![codecov](https://codecov.io/gh/ydb-platform/ydb-js-sdk/graph/badge.svg?component=topic)](https://ydb-appteam-sdk-reports.website.yandexcloud.net/ydb-js-sdk/coverage/packages/topic/)

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

Requires Node.js 22.15+ on the 22.x release line, or Node.js 23.8+.

Contributing? The internal state machines are mapped in [ARCHITECTURE.md](ARCHITECTURE.md).

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
- `codecMap?`: `Map<Codec | number, CompressionCodec>` — custom codecs for decompression (built-ins: RAW, GZIP, ZSTD)
- `maxBufferBytes?`: `bigint` — initial server read-credit window (default 8 MiB); an oversized message may exceed it
- `updateTokenIntervalMs?`: `number` — auth token refresh interval (default 60000)
- `gracefulShutdownTimeoutMs?`: `number` — force-close deadline for graceful `close()` before pending commits are dropped (default 30000)
- `recoveryWindowMs?`: `number` — terminal reconnect window; unbounded by default (reconnect forever, waiting for the server/topic), pass a finite ms value to bound it
- `retryOnSchemeError?`: `boolean` — retry on SCHEME_ERROR (e.g. the topic does not exist yet); off by default, enable to wait until the topic is created
- `autoPartitioningSupport?`: `boolean` — declare autopartitioning support to the server; ended partitions expose `childPartitionIds`/`adjacentPartitionIds` on their session (off by default)
- `onPartitionSessionStart?`: hook to adjust read/commit offsets per session
- `onPartitionSessionStop?`: on a graceful stop runs while the session is still committable and is awaited before the stop response — the last chance to commit processed offsets; on a forced stop or end-of-partition it is informational
- `onCommittedOffset?`: observe every server-confirmed commit advance (commit acks, stop watermarks, offset overrides)

`reader.bufferedBytes` exposes the server-accounted bytes currently retained by the reader and not yet fully delivered through `read()`.

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

for await (const batch of reader.read({ limit: 100, batchWindowMs: 1000 })) {
  if (!batch.length) continue // periodic empty batches when no data

  // Handle messages
  for (const m of batch) doSomething(m)

  // Option A (simple): await commit for each batch
  await reader.commit(batch)
}
```

`commit()` calls made synchronously in the same JavaScript turn are combined into one microtask batch and return the same promise. This keeps per-message concurrent processing efficient without allocating one public promise or sending one request per message. Passing the whole processed batch remains the clearest option. Awaiting every individual `commit(message)` before issuing the next one intentionally waits for a server round trip each time.

Always handle the returned promise. Ignoring it can surface a commit failure as an unhandled rejection; use `onCommittedOffset` as an observer, not as a replacement for error handling.

Commit semantics: each message acknowledges its own offset range (plus any server-side offset hole immediately preceding it — retention gaps and `readFrom` skips). A message you deliberately leave uncommitted is never covered by later commits of other messages, and the server advances the consumer offset only over gap-free acknowledged intervals — so a failed message keeps the committed offset behind it and is redelivered after a restart. Committing out of order is safe; an awaited `commit()` of a later message resolves once the earlier ones are committed too.

## Writer

### Options

- `topic`: `string`
- `tx?`: `TX` — transaction to write within
- `producer?`: `string` — producer id (auto‑generated if omitted)
- `codec?`: `CompressionCodec` — compression (default RAW; built-ins: RAW, GZIP, ZSTD)
- `maxBufferBytes?`: `bigint` — writer buffer cap (default 256 MiB)
- `maxInflightCount?`: `number` — max messages in‑flight (default 1000)
- `flushIntervalMs?`: `number` — periodic flush tick (default 1000ms)
- `updateTokenIntervalMs?`: `number` — auth token refresh interval (default 60000)
- `gracefulShutdownTimeoutMs?`: `number` — force-close deadline for graceful `close()` (default 30000)
- `recoveryWindowMs?`: `number` — terminal reconnect window; unbounded by default (reconnect forever, waiting for the server/topic), pass a finite ms value to bound it
- `retryOnSchemeError?`: `boolean` — retry on SCHEME_ERROR (e.g. the topic does not exist yet); off by default, enable to wait until the topic is created
- `partitionId?` / `messageGroupId?` — pin/route writes (mutually exclusive)
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

const payload = new TextEncoder().encode(JSON.stringify({ foo: 'bar', ts: Date.now() }))
writer.write(payload) // fire-and-forget (void)
// flush() returns the last acknowledged seqNo
const lastSeqNo = await writer.flush()
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

## License

Apache-2.0
