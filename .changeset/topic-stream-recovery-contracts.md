---
'@ydbjs/topic': patch
---

Resume pending reads, commits, and writes after transient stream deadlines and send buffered partial batches after reconnect without restarting their batching delay. Preserve reader source settings after caller mutation and contain rejected async acknowledgment observers. Clarify RAW buffer ownership.
