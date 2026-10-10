---
'@ydbjs/topic': patch
---

Preserve topic delivery guarantees and resource budgets across concurrent calls and reconnects.

- Prevent an earlier `flush()` completion from resolving a later flush before its messages are acknowledged.
- Release payload references recovered through reconnect deduplication, and always close writer streams and timers after an internal failure.
- Snapshot metadata and dates, avoid retaining oversized backing buffers, and reject invalid dates or sequence numbers before accepting a message.
- Preserve the reader's retained-byte budget across reconnects and account for releases during backoff without granting excess credit to a new stream.
- Honor read cancellation and partition revocation between slices of a response while preserving unread messages and releasing each response's credit once.
- Restore the `TopicTxWriter` type export for consumers that import the transactional writer contract.
- Restore timed batching: send full batches immediately and partial batches on `flushIntervalMs`; explicit `flush()` and `close()` drain without waiting for the interval. Preserve an expired flush deadline while the in-flight window is occupied.
- Keep graceful writer shutdown on the normal connection lifecycle, waiting for every reconnect handshake and cancelling obsolete retry timers after initialization.
- Ignore late stream completions and token refreshes from replaced connections, and prevent opening a stream after cancellation during driver readiness.
- Preserve transaction cancellation when updating read offsets, keep registered reader callbacks stable, and retain falsy destruction reasons in terminal errors.
- Generate default producer identities with `randomUUID()` and make manual flush sequence numbers independent of initialization timing.
