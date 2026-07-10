---
'@ydbjs/topic': major
---

Consolidate the topic writer onto a single deterministic `@ydbjs/fsm` state machine.

Breaking changes:

- `write()` now returns `void` instead of a sequence number. Obtain the last acknowledged `seqNo` via `flush()` (returns `bigint`) or the `onAck` callback.
- `flush()` now returns `bigint` (was `bigint | undefined`).
- Removed the experimental `@ydbjs/topic/writer2` subpath export.
- Removed the `retryConfig` writer option. The writer now reconnects transparently (exponential backoff + jitter) and, by default, indefinitely — waiting for the server/topic to come back; the new `recoveryWindowMs` option re‑imposes a terminal deadline. In‑flight messages are resent and pending writes are not failed by a transparent reconnect.
- `flushIntervalMs` default changed from 10ms to 1000ms.
- `close()` now rejects when the graceful drain fails (non‑retryable error, or timeout with undelivered messages) instead of resolving silently — this makes transactional commit hooks fail rather than commit with lost writes.

Fixes and additions:

- Non‑RAW codecs (GZIP/ZSTD) are now actually applied to the payload (previously the codec was declared on the wire but the bytes were sent uncompressed).
- `maxBufferBytes` is now enforced as a fail‑fast cap: `write()` throws synchronously when a message would push the un‑acknowledged buffer past the limit (default 256 MB), bounding writer memory.
- New options: `recoveryWindowMs` (finite reconnect deadline; unbounded by default), `retryOnSchemeError` (retry SCHEME_ERROR to wait for a not‑yet‑created topic; off by default), `gracefulShutdownTimeoutMs`, `partitionId` / `messageGroupId` (mutually exclusive), and `producer` is auto‑generated when omitted.
- Structured lifecycle events on `node:diagnostics_channel` under `ydb:topic.writer.*`.
