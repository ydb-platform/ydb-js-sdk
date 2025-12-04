---
title: Topic — Options
---

# Topic Reader/Writer Options and Methods

## Reader

- `topic`: `string | TopicReaderSource | TopicReaderSource[]`
  - `TopicReaderSource`: `{ path: string; partitionIds?: bigint[]; maxLag?: number | string | Duration; readFrom?: Date | Timestamp }`
- `consumer`: `string`
- `codecMap?`: `Map<Codec | number, CompressionCodec>` — additional decompression codecs
- `maxBufferBytes?`: `bigint` — internal buffer limit (default ~4 MB)
- `updateTokenIntervalMs?`: `number` — token refresh interval (default 60000)
- `onPartitionSessionStart?`: `(session, committedOffset, { start, end }) => Promise<void | { readOffset?, commitOffset? }>`
- `onPartitionSessionStop?`: `(session, committedOffset) => Promise<void>`
- `onCommittedOffset?`: `(session, committedOffset) => void`

Methods and behavior:

- `read({ limit?, waitMs?, signal? })`: `AsyncIterable<TopicMessage[]>`
  - Returns a sequence of message batches. `limit` caps the total messages fetched per iteration to control latency/memory. `waitMs` sets maximum wait for data; on timeout, the iterator yields an empty batch `[]`, enabling non‑blocking event loop integration. `signal` cancels waiting/reading.
  - Rationale: long blocking reads hurt cooperative multitasking; time‑based empty yields simplify scheduling without busy‑wait.
- `commit(messages | message)`: `Promise<void>`
  - Confirms processing up to the corresponding offset per affected partition (idempotent). Ensures subsequent reads start after the committed offset. Accepts one message or an array (a batch).
  - Why: implements at‑least‑once. Commit separates “read” from “processed” and enables safe recovery.
  - Performance: awaiting `commit()` on the hot path reduces throughput. Fire‑and‑forget (`void reader.commit(batch)`) is acceptable with `onCommittedOffset` as an observation mechanism.
- `close()`: `Promise<void>`
  - Graceful shutdown: stops accepting new data, waits for pending commits with a guard timeout, and stops background tasks.
- `destroy(reason?)`: `void`
  - Immediate stop; rejects pending commits and frees resources.

## Writer

- `topic`: `string`
- `tx?`: `TX` — write within a transaction
- `producer?`: `string`
- `codec?`: `CompressionCodec`
- `maxBufferBytes?`: `bigint` — default 256 MB
- `maxInflightCount?`: `number` — default 1000
- `flushIntervalMs?`: `number` — default 10 ms
- `updateTokenIntervalMs?`: `number` — default 60000
- `retryConfig?(signal)`: `RetryConfig`
- `onAck?(seqNo, status?)`: `(seqNo: bigint, status?: 'skipped' | 'written' | 'writtenInTx') => void`

Methods and behavior:

- `write(payload: Uint8Array, extra?)`: `bigint`
  - Buffers a message and returns assigned `seqNo`. You may provide `seqNo`, `createdAt`, `metadataItems`. Non‑blocking; actual sending occurs on `flush()` or by a periodic flusher.
  - Why `seqNo`: `producerId + seqNo` on the producer ensures idempotency, deterministic acks, and per‑partition order.
- `flush()`: `Promise<bigint | undefined>`
  - Flushes buffered messages, waits for inflight confirmations, and returns the last `seqNo`. Use at checkpoints (e.g., service shutdown).
- `close()`: `Promise<void>` — graceful stop (no new messages, wait for flush, free resources).
- `destroy()`: `void` — immediate stop without delivery guarantees.

Acknowledgements:

- `onAck(seqNo, status)`: notifies about message fate. `status`:
  - `written` — written outside a transaction
  - `writtenInTx` — written in a transaction (visible after commit)
  - `skipped` — skipped (e.g., `seqNo` conflict)

Retries and resilience:

- The connection to TopicService is streaming; it reestablishes on failures per `retryConfig`. Command queue is recreated.

Transactional variants:

- `createTopicTxReader(tx, ...)` and `createTopicTxWriter(tx, ...)` are bound to a Query transaction.
  - TxReader tracks read offsets and sends `updateOffsetsInTransaction` on `tx.onCommit`.
  - TxWriter triggers `flush` on `tx.onCommit` and shuts down correctly on `tx.onRollback/onClose`.
  - These do not implement `AsyncDisposable`; no `using` needed — the transaction controls lifecycle.
