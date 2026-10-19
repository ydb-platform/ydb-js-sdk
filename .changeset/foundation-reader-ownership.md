---
'@ydbjs/topic': patch
---

Keep reader payloads encoded until selected for delivery, preserve unread messages after clean close, and release them on destruction or terminal failure. Preserve transactional offset cancellation, snapshot settings and callbacks, and honor cancellation between slices of a response. maxBufferBytes accounts for wire response credit rather than decompressed payloads or RSS.

Stop the reader immediately on destruction, including synchronous callback reentry, and release pending payloads and commit waiters without requiring a subsequent close.
