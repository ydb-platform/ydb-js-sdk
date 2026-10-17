---
'@ydbjs/fsm': patch
---

Avoid Promise allocations for effect-free dispatch and reuse the fulfilled Promise within each drain of synchronous effects. Preserve effect ordering, microtask boundaries, and asynchronous context lifetime.
