---
'@ydbjs/grpc': patch
---

Preserve completed responses before malformed frame errors and after terminal trailers followed by HTTP/2 resets. Preserve repeated text trailer values. Reject service definitions with the reserved `close` method name and timer settings above Node's maximum delay.
