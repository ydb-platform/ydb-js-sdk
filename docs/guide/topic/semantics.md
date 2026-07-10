---
title: Topic — Semantics
---

# Semantics of Topic Reader/Writer

## Reader

- Streaming model: the server sends message batches over active partition sessions.
- `read({ limit, batchWindowMs, signal })` — async iterator of batches;
  - `limit` — max messages per iteration (no limit by default).
  - `batchWindowMs` — max time to accumulate a batch before yielding; empty batch on an idle topic.
  - `signal` — cancel waiting/reading.
- Commits: `commit(batch|msg)` — acknowledge processing on the server.
- Hooks:
  - `onPartitionSessionStart(session, committedOffset, { start, end })` — adjust `readOffset`/`commitOffset`.
  - `onPartitionSessionStop(session, committedOffset)` — finalize/commit.
  - `onCommittedOffset(session, committedOffset)` — ack notifications.

Buffering:

- Internal buffer limited by `maxBufferBytes`.
- `codecMap` controls payload decompression.

## Writer

- `write(payload)` — buffer a message; returns `seqNo`.
- `flush()` — send the buffer to the server; returns last `seqNo`.
- `onAck(seqNo, status)` — write acknowledgement notifications.
- Limits: `maxBufferBytes`, `maxInflightCount`, `flushIntervalMs`.
- Stream‑level transparent reconnect (exponential backoff + jitter); unbounded by default (retries forever, waiting for the server/topic), bounded by `recoveryWindowMs` when set. A running reader whose topic is dropped idles until the server closes the stale stream (~1 min), then transparently reconnects and resumes automatically if the topic exists again.

## Transactions

- TxReader: tracks read offsets and sends `updateOffsetsInTransaction` on tx commit.
- TxWriter: awaits `flush` before commit (via `tx.onCommit`).
- No `using`; lifecycle managed by transaction hooks.
