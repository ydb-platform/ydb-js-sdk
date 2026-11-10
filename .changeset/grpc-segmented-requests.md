---
'@ydbjs/grpc': minor
---

Allow request serializers to return a readonly array of byte segments. Send the segments as one gRPC message without combining them into a new buffer, validate their total size before writing, and respect HTTP/2 backpressure between segments.
