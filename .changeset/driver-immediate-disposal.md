---
'@ydbjs/core': major
---

Make Driver a synchronous Disposable resource. Closing or leaving a using scope cancels active work and closes connections immediately; remove the ten-second drain and async disposal. Topic readers and writers retain their own graceful completion and are disposed before Driver.
