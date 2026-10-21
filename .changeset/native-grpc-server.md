---
'@ydbjs/grpc': minor
---

Add a typed HTTP/2 gRPC server with Promise and AsyncIterable handlers, cancellation, deadlines, metadata, TLS, and backpressure. Synchronous disposal cancels active calls; explicit close drains accepted calls. Invalid response metadata fails only its RPC, and deadlines reset incomplete response messages instead of sending malformed gRPC responses.
