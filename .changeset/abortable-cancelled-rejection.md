---
'@ydbjs/abortable': minor
---

Accept an optional abort signal and return the original Promise when it is absent. Observe late rejections after cancellation, including when the signal was already aborted, without cancelling the underlying operation.
