---
'@ydbjs/topic': patch
---

Preserve topic delivery guarantees and resource budgets across concurrent calls and reconnects.

- Prevent an earlier `flush()` completion from resolving a later flush before its messages are acknowledged.
- Release payload references recovered through reconnect deduplication, and always close writer streams and timers after an internal failure.
- Include metadata and retention reserves in the writer's `maxBufferBytes` budget: 256 bytes per message and 64 bytes per metadata item, in addition to compressed payloads and metadata contents. Batches that previously filled the limit with payload alone may now need more buffer capacity. The budget is not an exact process-memory limit.
- Bound serialized write frames including metadata and transaction headers. Snapshot metadata and dates, avoid retaining oversized backing buffers, and reject invalid dates or sequence numbers before accepting a message.
- Preserve the reader's retained-byte budget across reconnects and account for releases during backoff without granting excess credit to a new stream.
- Honor read cancellation and partition revocation between slices of a response while preserving unread messages and releasing each response's credit once.
- Restore the `TopicTxWriter` type export for consumers that import the transactional writer contract.
