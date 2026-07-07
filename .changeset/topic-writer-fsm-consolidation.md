---
'@ydbjs/topic': major
---

Consolidate the topic writer onto a single deterministic `@ydbjs/fsm` state machine.

Breaking changes:

- `write()` now returns `void` instead of a sequence number. Obtain the last acknowledged `seqNo` via `flush()` (returns `bigint`) or the `onAck` callback.
- `flush()` now returns `bigint` (was `bigint | undefined`).
- Removed the experimental `@ydbjs/topic/writer2` subpath export.
- Removed the `retryConfig` writer option. The writer now reconnects transparently (exponential backoff + jitter) bounded by the new `recoveryWindowMs` option; in‑flight messages are resent and pending writes are not failed by a transparent reconnect.
- `flushIntervalMs` default changed from 10ms to 1000ms.
- `close()` now rejects when the graceful drain fails (non‑retryable error, or timeout with undelivered messages) instead of resolving silently — this makes transactional commit hooks fail rather than commit with lost writes.

Fixes and additions:

- Non‑RAW codecs (GZIP/ZSTD) are now actually applied to the payload (previously the codec was declared on the wire but the bytes were sent uncompressed).
- New options: `recoveryWindowMs`, `gracefulShutdownTimeoutMs`, `partitionId` / `messageGroupId` (mutually exclusive), and `producer` is auto‑generated when omitted.
- Structured lifecycle events on `node:diagnostics_channel` under `ydb:topic.writer.*`.
