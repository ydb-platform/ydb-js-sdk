---
'@ydbjs/topic': patch
---

Keep independent flush boundaries across acknowledgments and reconnect deduplication. Drain writer close through the normal connection lifecycle, preserve timed batching without repeated partial-batch scans, and release buffered messages, callbacks and codecs on shutdown. Restore the TopicTxWriter type export and contain rejected acknowledgment observers.
