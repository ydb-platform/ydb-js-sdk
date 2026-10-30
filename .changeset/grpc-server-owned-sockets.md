---
'@ydbjs/grpc': patch
---

Terminate server connections through their owned sockets during immediate shutdown. Avoid destroying the same HTTP/2 session again while a peer cancellation is already closing it.

Classify a cancelled stream on a closing HTTP/2 session as connection loss even before the runtime marks the session destroyed.
