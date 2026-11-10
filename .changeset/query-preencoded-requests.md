---
'@ydbjs/query': minor
---

Encode standalone tagged SQL text, settings and parameters before session admission and reuse the encoded request across automatic retries. Send the current session ID and query bytes as separate parts of one gRPC message. Remove protobuf graph snapshots and their internal exports. Explicit retry callbacks encode their current inputs on every statement call.
