---
'@ydbjs/grpc': patch
---

Release the transport's reference to a decoded response when the stream consumer advances, so an idle RPC does not retain the previously delivered object.
