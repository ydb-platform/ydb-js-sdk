---
'@ydbjs/fsm': patch
---

Preserve queued items when a paused consumer is cancelled immediately after the queue resumes. Release the previous yielded payload while an iterator waits for its next item.
