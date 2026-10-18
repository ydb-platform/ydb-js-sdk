---
'@ydbjs/topic': patch
---

Reduce topic reader allocations by consuming partition groups directly and releasing delivered message references while retaining unread messages.
