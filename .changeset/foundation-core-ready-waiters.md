---
'@ydbjs/core': patch
---

Release cancelled readiness waiters before discovery completes, without cancelling other callers. Reject readiness after driver shutdown and preserve the original cause of terminal discovery failures.
