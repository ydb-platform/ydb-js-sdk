---
'@ydbjs/query': patch
---

Keep caller cancellation terminal even when its reason is a retryable database error. Cover pre-aborted nested operations, statements and tagged queries, and streams cancelled before their first read. Preserve the original reason as the cause, and finish stream cleanup before classifying callback failures for retry.
