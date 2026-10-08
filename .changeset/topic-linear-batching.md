---
'@ydbjs/topic': patch
---

Avoid repeatedly scanning a partial writer batch on every `write()`. Track the encoded size of the unsent queue so readiness checks remain constant-time while preserving timed flushes, byte/count limits and reconnect recovery.
