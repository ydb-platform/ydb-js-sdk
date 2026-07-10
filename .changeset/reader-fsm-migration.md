---
'@ydbjs/topic': patch
---

Rebuild the topic reader on a deterministic `@ydbjs/fsm` state machine (transport FSM + reader FSM), mirroring the writer. The public `TopicReader` / `TopicTxReader` API (read / commit / close / destroy + callbacks) is unchanged; the behaviour is more reliable:

- `commit()` no longer rejects on a transparent reconnect. Pending commits are held per partition and re-sent on the new partition session (verified against a live server — YDB accepts a re-sent commit for offsets not read on that session), so a `read()` + `commit()` loop survives reconnects instead of crashing.
- Transactional read offsets are keyed by the stable partition id and survive a reconnect (previously lost, so the transaction could miss offsets).
- Byte flow-control is charged once per `ReadResponse` — a response spanning several partitions no longer over-releases credit.
- Retention gap-fill (committing past retention-deleted offsets) is preserved.
- `read()` accumulates a batch up to `limit`, yielding at least every `batchWindowMs` (empty batch on an idle topic, so the consumer never hangs). The option was renamed from `waitMs`, which remains as a deprecated alias.
- On an unrecoverable terminal error `read()` now throws (instead of ending like a clean end-of-stream); the reader is already torn down, so it is not reusable and every further `read()` / `commit()` throws too.
- Transparent reconnect is now unbounded by default (waits for the server/topic to come back); the new `recoveryWindowMs` option re-imposes a finite terminal deadline. The new `retryOnSchemeError` option (off by default) retries `SCHEME_ERROR` so a reader started before its topic exists waits until it is created. A running reader whose topic is dropped idles until the server closes the stale read stream (~1 min), then transparently reconnects and resumes automatically if the topic exists again (`retryOnSchemeError` extends this to a topic recreated later).
- Structured lifecycle events on `node:diagnostics_channel` under `ydb:topic.reader.*`, plus a `tracing:ydb:topic.reader.commit` span.
- `TopicTxReader` is now `AsyncDisposable` / `Disposable`.
