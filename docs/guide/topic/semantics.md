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

Resilience:

- Stream‑level transparent reconnect (exponential backoff + jitter); pending commits are re‑sent on the new partition session, so a `read()` + `commit()` loop survives reconnects.
- A running reader whose topic is dropped idles until the server closes the stale stream (~1 min), then transparently reconnects and resumes automatically if the topic exists again.

## Writer

- `write(payload)` — buffer a message; returns `void`. The final `seqNo` arrives via `flush()` or `onAck`.
- `flush()` — send the buffer to the server; returns the last acknowledged `seqNo`.
- `onAck(seqNo, status)` — write acknowledgement notifications.
- Limits: `maxBufferBytes`, `maxInflightCount`, `flushIntervalMs`.
- Stream‑level transparent reconnect (exponential backoff + jitter); unbounded by default (retries forever, waiting for the server/topic), bounded by `recoveryWindowMs` when set.

## Transactions

- TxReader: tracks read offsets and sends `updateOffsetsInTransaction` on tx commit.
- TxWriter: awaits `flush` before commit (via `tx.onCommit`).
- `using` is optional (both implement `AsyncDisposable`/`Disposable`); lifecycle is managed by transaction hooks.
