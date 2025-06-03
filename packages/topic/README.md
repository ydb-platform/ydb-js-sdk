# @ydbjs/topic

The `@ydbjs/topic` package provides high-level, type-safe clients for working with YDB topics (message queues) in JavaScript/TypeScript. It enables efficient streaming reads and writes, partition management, offset commits, and supports compression and custom payload encoding/decoding.

## Features

- Streaming topic reader and writer with async iteration
- Partition session management and offset commit
- Compression and custom payload encoding/decoding
- TypeScript support with type definitions
- Integration with `@ydbjs/core` and `@ydbjs/api`

## Installation

```sh
npm install @ydbjs/core@alpha @ydbjs/topic@alpha
```

## How It Works

- **TopicReader**: Reads messages from a YDB topic as async batches, manages partition sessions, and supports offset commits.
- **TopicWriter**: Writes messages to a YDB topic, supports batching, compression, and custom encoding.
- **Integration**: Use with a `Driver` from `@ydbjs/core` for connection management and authentication.

## Usage

### Reading from a Topic

```ts
import { Driver } from '@ydbjs/core'
import { TopicReader } from '@ydbjs/topic/reader'
import { Codec } from '@ydbjs/api/topic'

const driver = new Driver(process.env['YDB_CONNECTION_STRING']!)
await driver.ready()

await using reader = new TopicReader(driver, {
  topic: 'test-topic',
  consumer: 'test-consumer',
  maxBufferBytes: 64n * 1024n,
  compression: {
    decompress(codec, payload) {
      if (codec === Codec.GZIP) {
        return import('node:zlib').then((zlib) => zlib.gunzipSync(payload))
      } else {
        throw new Error(`Unsupported codec: ${codec}`)
      }
    },
  },
})

for await (let batch of reader.read({ limit: 50, waitMs: 1000 })) {
  console.log('received batch', batch.length)
  await reader.commit(batch)
}
```

### Writing to a Topic

```ts
import { Driver } from '@ydbjs/core'
import { TopicWriter } from '@ydbjs/topic/writer'
import { Codec } from '@ydbjs/api/topic'
import * as zlib from 'node:zlib'

const driver = new Driver(process.env['YDB_CONNECTION_STRING']!)
await driver.ready()

await using writer = new TopicWriter(driver, {
  topic: 'test-topic',
  producer: 'test-producer',
  maxBufferBytes: 64n * 1024n,
  flushIntervalMs: 5000,
  compression: {
    codec: Codec.GZIP,
    compress(payload) {
      return zlib.gzipSync(payload)
    },
  },
})

writer.write(new Uint8Array([1, 2, 3, 4]))
```

## Configuration & Options

### TopicReaderOptions

Options for configuring a `TopicReader` instance:

| Option                    | Type                                                    | Description & Best Practice                                                                                                                         |
| ------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `topic`                   | `string \| TopicReaderSource \| TopicReaderSource[]`    | Topic path or array of topic sources. Use a string for a single topic, or an array for multi-topic reading.                                         |
| `consumer`                | `string`                                                | Consumer name. Use a unique name per logical consumer group.                                                                                        |
| `maxBufferBytes`          | `bigint`                                                | Max internal buffer size in bytes. Increase for high-throughput, decrease to limit memory usage.                                                    |
| `updateTokenIntervalMs`   | `number`                                                | How often to update the token (ms). Default: 60000. Lower for short-lived tokens.                                                                   |
| `compression.decompress`  | `(codec, payload) => Uint8Array \| Promise<Uint8Array>` | Custom decompression function. Use for custom codecs or to enable GZIP/LZ4, etc.                                                                    |
| `decode`                  | `(payload: Uint8Array) => Payload`                      | Custom payload decoder. Use for JSON, protobuf, or other formats.                                                                                   |
| `onPartitionSessionStart` | `function`                                              | Called when a partition session starts. Use to set custom read/commit offsets.                                                                      |
| `onPartitionSessionStop`  | `function`                                              | Called when a partition session stops. Use to commit offsets or cleanup.                                                                            |
| `onCommittedOffset`       | `function`                                              | Called after offsets are committed. Use for monitoring or logging. For high-throughput, prefer this hook over awaiting `commit()` (see note below). |

> **Performance Note:**
>
> The `commit` method can be called without `await` to send commit requests to the server. If you use `await reader.commit(batch)`, your code will wait for the server's acknowledgment before continuing, which can significantly reduce throughput. For best performance in high-load scenarios, avoid awaiting `commit` directly in your main loop. Instead, use the `onCommittedOffset` hook to be notified when the server confirms the commit. This allows your application to process messages at maximum speed while still tracking commit confirmations asynchronously.

#### Example: Custom Decoder and Partition Hooks

```ts
await using reader = new TopicReader(driver, {
  topic: 'test-topic',
  consumer: 'my-consumer',
  decode(payload) {
    return JSON.parse(Buffer.from(payload).toString('utf8'))
  },
  onPartitionSessionStart(session, committedOffset, partitionOffsets) {
    console.log('Partition started', session.partitionId)
  },
  onPartitionSessionStop(session, committedOffset) {
    console.log('Partition stopped', session.partitionId)
  },
})
```

### TopicWriterOptions

Options for configuring a `TopicWriter` instance:

| Option                   | Type                                                         | Description & Best Practice                                                                                                                    |
| ------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `topic`                  | `string`                                                     | Topic path to write to. Required.                                                                                                              |
| `producer`               | `string`                                                     | Producer name. Set for idempotency and tracking.                                                                                               |
| `getLastSeqNo`           | `boolean`                                                    | Get last sequence number before writing. Use for exactly-once or deduplication.                                                                |
| `allowDuplicates`        | `boolean`                                                    | Allow duplicate messages. Set to true for at-most-once delivery.                                                                               |
| `updateTokenIntervalMs`  | `number`                                                     | How often to update the token (ms). Default: 60000.                                                                                            |
| `maxBufferBytes`         | `bigint`                                                     | Max buffer size in bytes. Increase for batching, decrease for low-latency.                                                                     |
| `maxInflightCount`       | `bigint`                                                     | Max in-flight messages. Tune for throughput vs. memory.                                                                                        |
| `flushIntervalMs`        | `number`                                                     | Auto-flush interval (ms). Lower for low-latency, higher for throughput.                                                                        |
| `compression.codec`      | `Codec`                                                      | Compression codec (e.g., GZIP). Use to reduce network usage.                                                                                   |
| `compression.compress`   | `(payload: Uint8Array) => Uint8Array \| Promise<Uint8Array>` | Custom compression function. Use for custom codecs or advanced compression.                                                                    |
| `compression.minRawSize` | `bigint`                                                     | Minimum payload size to compress. Avoids compressing small messages.                                                                           |
| `encode`                 | `(payload: Payload) => Uint8Array`                           | Custom encoder. Use for JSON, protobuf, or other formats.                                                                                      |
| `onAck`                  | `(seqNo: bigint, status?: string) => void`                   | Called on message acknowledgment. Use for tracking or logging. For high-throughput, prefer this hook over awaiting `write()` (see note below). |

> **Performance Note:**
>
> The `write` method adds messages to an internal buffer and returns a promise that resolves when the server acknowledges the write. If you use `await writer.write(...)`, your code will wait for the server's acknowledgment before continuing, which can significantly reduce throughput. For best performance in high-load scenarios, avoid awaiting `write` directly in your main loop. Instead, use the `onAck` hook to be notified when the server confirms the write. You can tune throughput and latency using `maxBufferBytes`, `maxInflightCount`, and `flushIntervalMs` options to control how quickly messages are sent to the server.

#### Example: Custom Encoder and Compression

```ts
await using writer = new TopicWriter(driver, {
  topic: 'test-topic',
  producer: 'json-producer',
  encode(payload) {
    return Buffer.from(JSON.stringify(payload), 'utf8')
  },
  compression: {
    codec: Codec.GZIP,
    compress(payload) {
      return zlib.gzipSync(payload)
    },
  },
  onAck(seqNo, status) {
    console.log('Ack for', seqNo, 'status:', status)
  },
})

writer.write({ foo: 'bar', ts: Date.now() })
```

## API

### TopicReader

- Reads messages from a topic as async batches
- Supports custom decompression and decoding
- Partition session hooks: `onPartitionSessionStart`, `onPartitionSessionStop`, `onCommittedOffset`
- Offset commit with `commit()`

### TopicWriter

- Writes messages to a topic, supports batching and compression
- Custom encoding and compression
- Ack callback: `onAck`

### Types

- `TopicMessage<Payload>`: Message structure for topic payloads
- `TopicReaderOptions`, `TopicWriterOptions`: Configuration options for reader and writer

## License

Apache-2.0
