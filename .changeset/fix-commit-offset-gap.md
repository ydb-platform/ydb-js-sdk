---
'@ydbjs/topic': patch
---

Fix commit hanging indefinitely when there's a gap between committedOffset and first available message offset (e.g., due to retention policy deleting old messages).
