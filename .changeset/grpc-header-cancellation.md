---
'@ydbjs/grpc': patch
---

Stop processing response trailers when a header observer closes or disposes the client. Report cancellation once and do not invoke trailer observers after shutdown.
