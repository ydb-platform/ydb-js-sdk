---
'@ydbjs/topic': minor
---

Fix seqNo renumbering bug in both writer implementations and simplify TopicWriter API.

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
