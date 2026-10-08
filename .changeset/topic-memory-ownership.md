---
'@ydbjs/core': patch
'@ydbjs/fsm': patch
'@ydbjs/topic': patch
---

Release cancelled readiness waiters and completed queue items instead of retaining their payloads until the driver or queue closes.

Keep topic reader buffers encoded until `read()` selects messages for delivery. Preserve the unread tail after a clean close and discard it on destruction or terminal failure, including when a read iterator is suspended. Release stopped partition state without pending commits and callbacks or custom codecs after client shutdown. Preserve delivered transaction offsets until the transaction finishes.

Read credit still uses each complete server response's `bytesSize`; no credit is inferred from individual message payloads. `maxBufferBytes` does not bound decompressed data or process RSS. Use `read({ limit })` to bound how many messages are decoded in one batch.
