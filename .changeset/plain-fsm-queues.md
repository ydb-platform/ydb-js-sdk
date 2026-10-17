---
'@ydbjs/fsm': patch
---

Drain queued events with an indexed FIFO and release consumed references without repeatedly shifting the backlog. Keep queue readers isolated across reset, honor repeated pauses, and preserve already assigned values and terminal results during cancellation. Do not open an ingest source when its signal is already aborted.
