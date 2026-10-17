---
'@ydbjs/fsm': patch
---

Avoid allocating a new drain waiter for each event queued behind an active effect. The active drain processes the queued events in order.
