---
'@ydbjs/grpc': patch
---

Terminate server connections through their owned sockets during immediate shutdown. Avoid destroying the same HTTP/2 session again while a peer cancellation is already closing it.

Classify synthetic CANCEL during socket loss as UNAVAILABLE even before the runtime marks the HTTP/2 session destroyed. Preserve a server CANCEL on a healthy connection draining after graceful GOAWAY.
