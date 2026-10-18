---
'@ydbjs/fsm': patch
---

Drain queued events with an indexed FIFO and release consumed references without repeatedly shifting the backlog. Avoid redundant drain waiters and Promise work for effect-free dispatch, and reuse the fulfilled Promise within each drain of synchronous effects. Preserve event order, microtask boundaries, shutdown behavior, and asynchronous context lifetime. Do not open an ingest source when its signal is already aborted.
