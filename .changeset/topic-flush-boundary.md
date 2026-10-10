---
'@ydbjs/topic': patch
---

Make `flush()` wait for acknowledgments of writes accepted before the call. Later writes no longer extend a pending flush. Independent flush boundaries survive reconnect and server deduplication; terminal errors still reject unconfirmed flushes. Use `close()` to stop admission and drain the entire writer.
