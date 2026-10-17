---
'@ydbjs/grpc': minor
'@ydbjs/api': major
'@ydbjs/auth': major
'@ydbjs/core': major
'@ydbjs/coordination': major
'@ydbjs/query': major
'@ydbjs/retry': major
'@ydbjs/telemetry': major
'@ydbjs/topic': major
'@ydbjs/error': minor
---

Replace the nice-grpc transport stack with the dependency-free `@ydbjs/grpc` client over Node.js HTTP/2. Service methods retain Promise results and AsyncIterable request/response streams, with AbortSignal cancellation and backpressure. Requires Node.js 22.15 or later supported by the SDK.

Use `createServiceClient(service, transport)` for standalone calls. `Driver.createClient` retains discovery and node selection; `createPinnedClient` explicitly awaits endpoint pin acquisition. Configure TLS, message limits, and HTTP/2 windows through `transportOptions`. The transport does not replay RPCs or duplicate YDB balancing and retry policies.

Call options accept plain metadata records, signals, absolute deadlines, and header/trailer/status observers. `RpcError` carries code, details, and trailing metadata; `MessageSizeError` identifies permanent local size-limit failures. Query metadata events expose the same record format. Register `addMetadataHook` before constructing Driver to add tracing headers. Credential providers supply `getToken`; Driver handles authentication and mandatory headers without middleware or interceptor adapters.

High-level TopicWriter, TopicReader, query, and coordination operations retain their APIs. Generated API definitions remain independent of the transport at runtime. Request framing sends the header and serialized body separately, avoiding the payload copy used to prepend a gRPC frame header.

Decode incoming HTTP/2 fragments into bounded gRPC frame batches before async iteration, preserving cancellation and response ordering without scheduling an iterator step for every fragment.
