---
'@ydbjs/topic': major
---

Harden the topic reader's commit semantics and multi-topic support, extend the reader/writer contracts:

- Multi-topic readers key all partition state by (topic, partition id): topics sharing partition ids no longer collide (previously messages of one topic could be silently dropped and its commits attributed to the other topic's partition).
- `commit()` acknowledges exactly the messages it was given: each message covers its own offset range plus the server-side hole immediately preceding it (retention gaps, `readFrom` skips). Delivered-but-uncommitted messages are never covered by another message's commit; sparse commits resolve once the server watermark reaches them; overlapping commits never resolve before that watermark. Synchronous calls are combined into one microtask batch and return the same promise, so per-message concurrent processing produces one commit request instead of one request and promise per message. A commit racing a partition stop rejects immediately instead of hanging until the reassign GC.
- `commit()` rejects messages that belong to another reader's partition session.
- `onCommittedOffset` fires on every server-confirmed advance — commit acks, stop-request watermarks and partition status responses — including ended and stopped partitions. Start-hook `commitOffset` overrides are confirmed through partition status before resolving pending commits or notifying observers; graceful close waits for that confirmation.
- Soft partition stop honors the documented contract: `onPartitionSessionStop` is awaited before the stop response is sent and the partition keeps accepting reads and commits meanwhile — a real "last chance to commit".
- Transactional readers bind offsets at `read()` delivery (never covering buffered messages the consumer did not see), cover head gaps from the committed offset, keep tracked offsets when closed before the transaction commits, and route `UpdateOffsetsInTransaction` to the transaction session's node.
- `read()` validates `limit` and `batchWindowMs`; a read aborted mid-accumulation redelivers the accumulated messages on the next `read()` instead of dropping them.
- Large batches of small messages are delivered without exceeding the JavaScript function argument limit.
- Read flow-control credit is returned only after every message from a server response has passed through the async iterable. `reader.bufferedBytes` and `ydb:topic.reader.buffer.changed` expose the server-accounted bytes still retained by the reader.
- New reader option `autoPartitioningSupport` declares autopartitioning support to the server; ended partition sessions expose `childPartitionIds` / `adjacentPartitionIds`.
- The writer validates its configured codec against the server's `supportedCodecs` at init — fail-fast with an actionable error instead of a terminal server error after buffering — and rejects an empty `producer` id (silent no-dedup mode).
- `readFrom: 0` (the epoch) and `maxLag: 0` reach the InitRequest instead of being silently dropped.
- Drop Node.js 20 support. Require Node.js 22.15+ on the 22.x release line or Node.js 23.8+, with built-in RAW, GZIP and ZSTD codecs available on every supported runtime.
