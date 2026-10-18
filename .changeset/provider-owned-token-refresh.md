---
'@ydbjs/auth': patch
'@ydbjs/auth-yandex-cloud': patch
---

Keep shared token refreshes independent of individual callers. Static, metadata, and Yandex Cloud providers own a five-second foreground request budget, including retries; static and Yandex Cloud background refreshes have a thirty-second budget. Cancelling a token request stops only that caller's wait. Cached reads and callers joining a refresh do not create provider timeouts.
