---
'@ydbjs/topic': minor
---

- Add `resolveSeqNo()` method to `TopicWriter` to resolve temporary sequence numbers to final values after session re-initialization. Refactored seqNo tracking logic into `SeqNoResolver` and `SeqNoShiftBuilder` classes for better testability and maintainability.

**Important:** The `write()` method now returns **temporary** seqNo values that may be recalculated after session initialization or reconnection. To get the final seqNo assigned by the server, use `resolveSeqNo()` after `flush()` completes.

**New API:**

- `TopicWriter.resolveSeqNo(initialSeqNo: bigint): bigint` - resolves temporary seqNo returned by `write()` to final seqNo assigned by server

**Behavior changes:**

- `write()` returns temporary seqNo (may change after session re-initialization)
- User-provided seqNo (via `extra.seqNo`) remain final and unchanged
- After `flush()` completes, all seqNo up to returned `lastSeqNo` are final

**Migration guide:**

- If you store seqNo immediately after `write()`, consider using `resolveSeqNo()` after `flush()` to get final values
- User-provided seqNo are always final and don't require `resolveSeqNo()`
