---
title: Topic — Options
---

# Topic Reader/Writer Options and Methods

## Reader

- `topic`: `string | TopicReaderSource | TopicReaderSource[]`
  - `TopicReaderSource`: `{ path: string; partitionIds?: bigint[]; maxLag?: number | string | Duration; readFrom?: number | Date | Timestamp }`
- `consumer`: `string`
- `codecMap?`: `Map<Codec | number, CompressionCodec>` — additional decompression codecs (built-ins: RAW, GZIP, ZSTD)
- `maxBufferBytes?`: `bigint` — server read-credit budget (default 8 MiB), not a limit on decompressed memory; an oversized message may exceed it
- `updateTokenIntervalMs?`: `number` — token refresh interval (default 60000)
- `gracefulShutdownTimeoutMs?`: `number` — force-close deadline for graceful `close()` before pending commits are dropped (default 30000)
- `recoveryWindowMs?`: `number` — terminal reconnect window; unbounded by default (reconnect forever), pass a finite ms value to bound it
- `retryOnSchemeError?`: `boolean` — retry on SCHEME_ERROR (e.g. the topic does not exist yet); off by default, enable to wait until the topic is created
- `onPartitionSessionStart?`: `(session, committedOffset, { start, end }) => Promise<void | { readOffset?, commitOffset? }>`
- `onPartitionSessionStop?`: `(session, committedOffset) => Promise<void>`
- `onCommittedOffset?`: `(session, committedOffset) => void`

Methods and behavior:

- `read({ limit?, batchWindowMs?, signal? })`: `AsyncIterable<TopicMessage[]>`
  - Returns a sequence of message batches. `limit` caps the total messages fetched per iteration to control latency/memory. `batchWindowMs` sets the max time to accumulate a batch before yielding; on an idle topic, the iterator yields an empty batch `[]`, enabling non‑blocking event loop integration. `signal` cancels waiting/reading.
  - Rationale: long blocking reads hurt cooperative multitasking; time‑based empty yields simplify scheduling without busy‑wait.
- `commit(messages | message)`: `Promise<void>`
  - Acknowledges only the supplied messages and server-side offset holes preceding them. Later commits do not acknowledge a message left uncommitted. The consumer offset advances over contiguous acknowledged ranges; committing out of order is supported, but a later commit waits for earlier gaps to be acknowledged.
  - Why: implements at‑least‑once. Commit separates “read” from “processed” and enables safe recovery.
  - Await the commit promise to observe acknowledgment or failure. When commits run concurrently, retain their promises and handle rejections.
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
- `flushIntervalMs?`: `number` — default 1000 ms
- `updateTokenIntervalMs?`: `number` — default 60000
- `gracefulShutdownTimeoutMs?`: `number` — default 30000
- `recoveryWindowMs?`: `number` — terminal reconnect window; unbounded by default (reconnect forever), pass a finite ms value to bound it
- `retryOnSchemeError?`: `boolean` — retry on SCHEME_ERROR (e.g. the topic does not exist yet); off by default, enable to wait until the topic is created
- `partitionId?` / `messageGroupId?` — pin/route writes (mutually exclusive)
- `onAck?(seqNo, status)`: `(seqNo: bigint, status: 'skipped' | 'written' | 'writtenInTx') => void`

Methods and behavior:

- `write(payload: Uint8Array, extra?)`: `void`
  - Buffers a message. You may provide `seqNo` (manual mode), `createdAt`, `metadataItems`. Non‑blocking; actual sending occurs on `flush()` or by a periodic flusher. The final `seqNo` is obtained via `flush()` or `onAck`.
  - Why `seqNo`: `producer + seqNo` ensures idempotency, deterministic acks, and per‑partition order.
- `flush(signal?)`: `Promise<bigint>`
  - Waits for writes accepted before this call and returns their sequence boundary. Later writes do not extend the wait. Cancelling the wait does not revoke accepted writes.
- `close(signal?)`: `Promise<void>` — graceful stop (no new messages, wait for flush, free resources). Rejects if the drain fails.
- `destroy(reason?)`: `void` — immediate stop without delivery guarantees.

Acknowledgements:

- `onAck(seqNo, status)`: notifies about message fate. `status`:
  - `written` — written outside a transaction
  - `writtenInTx` — written in a transaction (visible after commit)
  - `skipped` — skipped (e.g., `seqNo` conflict)

Retries and resilience:

- The connection to TopicService is streaming; it transparently reconnects on failures with exponential backoff + jitter. By default it reconnects indefinitely (waiting for the server/topic); pass `recoveryWindowMs` to impose a terminal deadline. Enable `retryOnSchemeError` to also retry SCHEME_ERROR and wait until the topic is created. In‑flight messages are resent; pending writes are not failed by a transparent reconnect.

Transactional variants:

- `createTopicTxReader(tx, ...)` and `createTopicTxWriter(tx, ...)` are bound to a Query transaction.
  - TxReader tracks delivered offsets and sends `updateOffsetsInTransaction` on `tx.onCommit`.
  - TxWriter drains accepted writes through `close(signal)` in `tx.onCommit`; rollback or uncommitted close destroys pending work.
  - Let transaction hooks own their lifecycle. Do not close or dispose them inside the transaction callback: cleanup before commit can prevent delivery or offset updates.
