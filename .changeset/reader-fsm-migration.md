---
'@ydbjs/topic': major
---

Rebuild the topic reader on a deterministic `@ydbjs/fsm` state machine (transport FSM + reader FSM), mirroring the writer. The public `TopicReader` / `TopicTxReader` API (read / commit / close / destroy + callbacks) is unchanged; the behaviour is more reliable:

- `commit()` no longer rejects on a transparent reconnect. Pending commits are held per partition and re-sent on the new partition session (verified against a live server — YDB accepts a re-sent commit for offsets not read on that session), so a `read()` + `commit()` loop survives reconnects instead of crashing.
- Transactional read offsets are keyed by the stable partition id and survive a reconnect (previously lost, so the transaction could miss offsets).
- Byte flow-control is charged once per `ReadResponse` — a response spanning several partitions no longer over-releases credit.
- Retention gap-fill (committing past retention-deleted offsets) is preserved.
- `read()` accumulates a batch up to `limit`. With `batchWindowMs` set it yields at least every window (an empty batch on an idle topic, so a polling consumer never hangs); without it, it blocks until the next delivered chunk. The option was renamed from `waitMs`, which remains as a deprecated alias.
- On an unrecoverable terminal error `read()` now throws (instead of ending like a clean end-of-stream); the reader is already torn down, so it is not reusable and every further `read()` / `commit()` throws too.
- Transparent reconnect is now unbounded by default (waits for the server/topic to come back); the new `recoveryWindowMs` option re-imposes a finite terminal deadline. The new `retryOnSchemeError` option (off by default) retries `SCHEME_ERROR` so a reader started before its topic exists waits until it is created. A running reader whose topic is dropped idles until the server closes the stale read stream (~1 min), then transparently reconnects and resumes automatically if the topic exists again (`retryOnSchemeError` extends this to a topic recreated later).
- The new `gracefulShutdownTimeoutMs` option makes the graceful `close()` deadline configurable (default 30 s): past it, pending commits are dropped and the reader force-closes.
- Structured lifecycle events on `node:diagnostics_channel` under `ydb:topic.reader.*`, plus a `tracing:ydb:topic.reader.commit` span.
- `TopicTxReader` is now `AsyncDisposable` / `Disposable`. A manual `commit()` on a tx reader now throws — the `TopicTxReader` type never exposed it, but the runtime object did, and a plain-JS call would commit offsets outside the transaction (they would survive its rollback).
- `TopicPartitionSession.nextCommitStartOffset` is removed from the public class. It was commit-machinery state that leaked into the public surface in 6.1.x: user-visible (and mutable), while a corrupted anchor produces malformed commit ranges — which are session-fatal server-side. The gap-fill anchor now lives inside the reader state machine, keyed by the stable partition id, so it also survives reconnects (the session object does not).
- The default `maxBufferBytes` (server read credit / client-side buffer cap) is now 8 MiB, up from 4 MiB.
