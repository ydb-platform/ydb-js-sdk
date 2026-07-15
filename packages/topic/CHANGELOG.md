# @ydbjs/topic

## 7.0.0

### Major Changes

- [#637](https://github.com/ydb-platform/ydb-js-sdk/pull/637) [`51d3c1b`](https://github.com/ydb-platform/ydb-js-sdk/commit/51d3c1b98396f9e2c131a488d85cfdc0138bd1e9) Thanks [@YandalfRed](https://github.com/YandalfRed)! - Rebuild the topic reader on a deterministic `@ydbjs/fsm` state machine (transport FSM + reader FSM), mirroring the writer. The public `TopicReader` / `TopicTxReader` API (read / commit / close / destroy + callbacks) is unchanged; the behaviour is more reliable:
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

- [#637](https://github.com/ydb-platform/ydb-js-sdk/pull/637) [`8eefff2`](https://github.com/ydb-platform/ydb-js-sdk/commit/8eefff245e328f8aa79acef69d663906f1e02c04) Thanks [@YandalfRed](https://github.com/YandalfRed)! - Consolidate the topic writer onto a single deterministic `@ydbjs/fsm` state machine.

  Breaking changes:
  - `write()` now returns `void` instead of a sequence number. Obtain the last acknowledged `seqNo` via `flush()` (returns `bigint`) or the `onAck` callback.
  - `flush()` now returns `bigint` (was `bigint | undefined`).
  - Removed the experimental `@ydbjs/topic/writer2` subpath export.
  - Removed the `retryConfig` writer option. The writer now reconnects transparently (exponential backoff + jitter) and, by default, indefinitely — waiting for the server/topic to come back; the new `recoveryWindowMs` option re‑imposes a terminal deadline. In‑flight messages are resent and pending writes are not failed by a transparent reconnect.
  - `flushIntervalMs` default changed from 10ms to 1000ms.
  - `close()` now rejects when the graceful drain fails (non‑retryable error, or timeout with undelivered messages) instead of resolving silently — this makes transactional commit hooks fail rather than commit with lost writes.

  Fixes and additions:
  - Non‑RAW codecs (GZIP/ZSTD) are compressed once at `write()` and the compressed bytes are what the buffer accounts and the wire carries.
  - `maxBufferBytes` is now enforced as a fail‑fast cap: `write()` throws synchronously when a message would push the un‑acknowledged buffer past the limit (default 256 MB), bounding writer memory.
  - New options: `recoveryWindowMs` (finite reconnect deadline; unbounded by default), `retryOnSchemeError` (retry SCHEME_ERROR to wait for a not‑yet‑created topic; off by default), `gracefulShutdownTimeoutMs`, `partitionId` / `messageGroupId` (mutually exclusive), and `producer` is auto‑generated when omitted.
  - Structured lifecycle events on `node:diagnostics_channel` under `ydb:topic.writer.*`.

### Patch Changes

- [#638](https://github.com/ydb-platform/ydb-js-sdk/pull/638) [`5d0cc28`](https://github.com/ydb-platform/ydb-js-sdk/commit/5d0cc2869176b222a6c12e6f3455a530178599be) Thanks [@polRk](https://github.com/polRk)! - Widen the reader's internal `PartitionReadData` timestamp fields (`writtenAt`, `createdAt`) to `Timestamp | undefined` to match the stricter optional-field typing from the regenerated `@ydbjs/api`. No behavioural change.

- [#637](https://github.com/ydb-platform/ydb-js-sdk/pull/637) [`51d3c1b`](https://github.com/ydb-platform/ydb-js-sdk/commit/51d3c1b98396f9e2c131a488d85cfdc0138bd1e9) Thanks [@YandalfRed](https://github.com/YandalfRed)! - The built-in ZSTD codec no longer crashes with a bare `TypeError` on runtimes where `node:zlib` has no zstd support (Node.js before 22.15 / 23.8). `getCodec(Codec.ZSTD)` and `ZSTD_CODEC` now throw an actionable error naming the required Node.js versions, the default reader codec map registers ZSTD only when the runtime supports it, and a reader that receives ZSTD data on an older runtime fails with the register-it-in-`codecMap` error instead.

- Updated dependencies [[`5d0cc28`](https://github.com/ydb-platform/ydb-js-sdk/commit/5d0cc2869176b222a6c12e6f3455a530178599be), [`807010c`](https://github.com/ydb-platform/ydb-js-sdk/commit/807010c6d784828b63676e351fd807ae0dd47338), [`65ba0fd`](https://github.com/ydb-platform/ydb-js-sdk/commit/65ba0fdf81aaaa880699633b005e1cf134f226a8), [`6c3dee3`](https://github.com/ydb-platform/ydb-js-sdk/commit/6c3dee3e5a84c666c3425cac779e18adc53be2b1)]:
  - @ydbjs/api@7.0.0
  - @ydbjs/core@7.0.0
  - @ydbjs/fsm@7.0.0
  - @ydbjs/error@6.0.7
  - @ydbjs/retry@6.3.1
  - @ydbjs/value@6.0.9

## 6.1.4

### Patch Changes

- [#623](https://github.com/ydb-platform/ydb-js-sdk/pull/623) [`f78bc01`](https://github.com/ydb-platform/ydb-js-sdk/commit/f78bc017482c2acb60a28f12c83eebd21569de63) Thanks [@polRk](https://github.com/polRk)! - Bump `@bufbuild/protobuf` from `2.10.1` to `2.12.0`.

- Updated dependencies [[`f78bc01`](https://github.com/ydb-platform/ydb-js-sdk/commit/f78bc017482c2acb60a28f12c83eebd21569de63)]:
  - @ydbjs/api@6.0.7
  - @ydbjs/core@6.3.1
  - @ydbjs/error@6.0.6
  - @ydbjs/value@6.0.8

## 6.1.3

### Patch Changes

- [#603](https://github.com/ydb-platform/ydb-js-sdk/pull/603) [`8d40d0d`](https://github.com/ydb-platform/ydb-js-sdk/commit/8d40d0d1bb5908e011adba7372cdf64639fc8234) Thanks [@copilot-swe-agent](https://github.com/apps/copilot-swe-agent)! - Preserve `createdAt`, `writtenAt`, and `metadataItems` on `TopicMessage` when constructed from options. Previously the constructor dropped these fields, so messages produced by readers always exposed them as `undefined`.

- Updated dependencies [[`efa7adf`](https://github.com/ydb-platform/ydb-js-sdk/commit/efa7adf9e1346388a4358f3e1bf8a8ac5c85419b), [`fa32650`](https://github.com/ydb-platform/ydb-js-sdk/commit/fa32650b5393052e5802126f114355b9d3720448), [`b8b5ef5`](https://github.com/ydb-platform/ydb-js-sdk/commit/b8b5ef56b600cec4261680a5b211f4c2dd81259f), [`17d1020`](https://github.com/ydb-platform/ydb-js-sdk/commit/17d10200b0dbd1dd0d48041bf377f91dc1a15d75)]:
  - @ydbjs/core@6.2.0
  - @ydbjs/retry@6.3.0

## 6.1.2

### Patch Changes

- [#560](https://github.com/ydb-platform/ydb-js-sdk/pull/560) [`9123c13`](https://github.com/ydb-platform/ydb-js-sdk/commit/9123c13199871cb994ce146ccc2e83c2edf10399) Thanks [@polRk](https://github.com/polRk)! - Fix topic reader/writer disconnecting after Discovery.listEndpoints

  When the driver refreshed its endpoint pool on a periodic discovery round,
  it closed and recreated gRPC channels for all known nodes. This caused active
  bidirectional streams (topic reader / writer) to receive a `CANCELLED` gRPC
  status, which was not treated as a retryable error — so the streams terminated
  instead of reconnecting.

  Changes:
  - **`@ydbjs/retry`**: added `isRetryableStreamError` and `defaultStreamRetryConfig`.
    Long-lived streaming RPCs should reconnect on `CANCELLED` and `UNAVAILABLE`
    in addition to the errors already handled by `isRetryableError`, because for
    streams those codes indicate a transport interruption rather than a semantic
    cancellation.
  - **`@ydbjs/topic`**: reader (`_consume_stream`) and both writers (`writer`,
    `writer2`) now use `isRetryableStreamError` / `defaultStreamRetryConfig` so
    they transparently reconnect after a discovery-triggered channel replacement.
    Fixed a zombie-reader bug where `read()` would block forever if the retry
    budget was exhausted: the reader is now destroyed on unrecoverable stream
    errors so pending `read()` calls are unblocked immediately.

- Updated dependencies [[`9123c13`](https://github.com/ydb-platform/ydb-js-sdk/commit/9123c13199871cb994ce146ccc2e83c2edf10399)]:
  - @ydbjs/retry@6.1.0

## 6.1.1

### Patch Changes

- [#554](https://github.com/ydb-platform/ydb-js-sdk/pull/554) [`85b2ea0`](https://github.com/ydb-platform/ydb-js-sdk/commit/85b2ea05092e96943ccc2ed2fe1164d67345a910) Thanks [@polRk](https://github.com/polRk)! - Fix commit hanging indefinitely when there's a gap between committedOffset and first available message offset (e.g., due to retention policy deleting old messages).

## 6.1.0

### Minor Changes

- [#545](https://github.com/ydb-platform/ydb-js-sdk/pull/545) [`4a8ebba`](https://github.com/ydb-platform/ydb-js-sdk/commit/4a8ebba603527b10a9ffa9f1f7be244a99c72451) Thanks [@polRk](https://github.com/polRk)! - Fix seqNo renumbering bug in both writer implementations and simplify TopicWriter API.

  **Bug fix:**
  - Fixed issue where messages written before session initialization were not renumbered after receiving `lastSeqNo` from server. Previously, auto-generated seqNo started from 0 and were not updated when server provided actual `lastSeqNo`, causing seqNo conflicts. Now messages are properly renumbered to continue from server's `lastSeqNo + 1`.
  - Fixed in both `writer` (legacy) and `writer2` implementations

  **API changes:**
  - `TopicWriter.write()` no longer returns sequence number (now returns `void`) to simplify API and prevent confusion about temporary vs final seqNo values

  **Migration guide:**
  - If you were storing seqNo from `write()` return value, use `flush()` instead to get final seqNo:

    ```typescript
    // Before
    let seqNo = writer.write(data)

    // After
    writer.write(data)
    let lastSeqNo = await writer.flush() // Get final seqNo
    ```

  - User-provided seqNo (via `extra.seqNo`) remain final and unchanged - no migration needed for this case.

### Patch Changes

- [#547](https://github.com/ydb-platform/ydb-js-sdk/pull/547) [`a0f39b6`](https://github.com/ydb-platform/ydb-js-sdk/commit/a0f39b6e3cf974feb1345c9f6eeca25d82ed1aeb) Thanks [@polRk](https://github.com/polRk)! - Fix memory leaks in topic reader implementation.
  - Fixed memory leaks in AsyncPriorityQueue by properly clearing items and resetting state
  - Improved abort signal handling to prevent memory accumulation from composite signals
  - Enhanced resource cleanup in TopicReader and TopicTxReader destroy methods
  - Added proper disposal of outgoing queue and message buffers
  - Added both sync and async disposal support with proper cleanup
  - Added memory leak test to prevent regressions

## 6.0.7

### Patch Changes

- Fix discovery client undefined check

- Updated dependencies []:
  - @ydbjs/core@6.0.7

## 6.0.6

### Patch Changes

- Fix memory leaks in Driver class

- Updated dependencies []:
  - @ydbjs/core@6.0.6

## 6.0.5

### Patch Changes

- Reduce npm package size by limiting published files to dist, README.md, and CHANGELOG.md only
- Updated dependencies
  - @ydbjs/api@6.0.5
  - @ydbjs/core@6.0.5
  - @ydbjs/debug@6.0.5
  - @ydbjs/error@6.0.5
  - @ydbjs/retry@6.0.5
  - @ydbjs/value@6.0.5

## 6.0.4

### Patch Changes

- cb0db2f: Update dependencies
- Updated dependencies [cb0db2f]
  - @ydbjs/debug@6.0.4
  - @ydbjs/error@6.0.4
  - @ydbjs/retry@6.0.4
  - @ydbjs/value@6.0.4
  - @ydbjs/core@6.0.4
  - @ydbjs/api@6.0.4

## 6.0.3

### Patch Changes

- Fix access to tx in topic reader
  - @ydbjs/api@6.0.3
  - @ydbjs/core@6.0.3
  - @ydbjs/debug@6.0.3
  - @ydbjs/error@6.0.3
  - @ydbjs/retry@6.0.3
  - @ydbjs/value@6.0.3

## 6.0.2

### Patch Changes

- @ydbjs/api@6.0.2
- @ydbjs/core@6.0.2
- @ydbjs/debug@6.0.2
- @ydbjs/error@6.0.2
- @ydbjs/retry@6.0.2
- @ydbjs/value@6.0.2

## 6.0.1

### Patch Changes

- Update topic tx reader/client client constructor. Remove disposable features for tx clients.
  - @ydbjs/api@6.0.1
  - @ydbjs/core@6.0.1
  - @ydbjs/debug@6.0.1
  - @ydbjs/error@6.0.1
  - @ydbjs/retry@6.0.1
  - @ydbjs/value@6.0.1
