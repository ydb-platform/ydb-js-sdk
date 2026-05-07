---
'@ydbjs/topic': patch
---

Preserve `createdAt`, `writtenAt`, and `metadataItems` on `TopicMessage` when constructed from options. Previously the constructor dropped these fields, so messages produced by readers always exposed them as `undefined`.
