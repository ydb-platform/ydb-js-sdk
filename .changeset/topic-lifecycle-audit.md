---
'@ydbjs/core': patch
'@ydbjs/fsm': patch
'@ydbjs/topic': patch
---

Expire unreassigned reader partitions after reconnect even when their commits arrive after session initialization. Reject non-positive reader buffer limits instead of leaving reads stalled.

Keep discovered and explicitly pinned connections separate, close only the affected connection during retirement or invalidation, and drain both during driver shutdown. Preserve the configured TLS server name when discovery provides no override, and omit driver options from debug logging.

Preserve queued items when a paused read is cancelled immediately after resuming.
