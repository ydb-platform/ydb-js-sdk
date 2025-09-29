---
title: Topic — Semantics
---

# Semantics of Topic Reader/Writer

## Reader

- Streaming model: the server sends message batches over active partition sessions.
- `read({ limit, waitMs, signal })` — async iterator of batches;
  - `limit` — max messages per iteration (no limit by default).
  - `waitMs` — max wait before returning an empty batch.
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
- Stream‑level retries with configurable strategy (`retryConfig`).

## Transactions

- TxReader: tracks read offsets and sends `updateOffsetsInTransaction` on tx commit.
- TxWriter: awaits `flush` before commit (via `tx.onCommit`).
- No `using`; lifecycle managed by transaction hooks.
