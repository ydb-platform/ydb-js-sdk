---
'@ydbjs/topic': patch
---

Stop TopicWriter synchronously on destroy, release pending writes and callback references, and reject outstanding flush and close operations. Stop acknowledgment delivery when a callback or diagnostics subscriber destroys the writer. Preserve the first destruction or runtime failure reason when synchronous transport completion hooks reenter destroy. Graceful close continues to drain accepted writes and can still be interrupted by destroy.

Cancel reader and writer credential waits when their stream is destroyed or replaced, while leaving shared provider refreshes running.
