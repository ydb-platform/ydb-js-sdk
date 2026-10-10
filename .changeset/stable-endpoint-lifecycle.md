---
'@ydbjs/core': patch
---

Keep active channels alive when an endpoint repeatedly disappears from and returns to discovery. Reject `ready()` after driver shutdown while preserving the original cause of an initial discovery failure.
