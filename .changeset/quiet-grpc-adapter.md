---
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

Replace nice-grpc with a small async adapter over grpc-js 1.14.6 or later. Service methods retain Promise results and AsyncIterable request/response streams, with AbortSignal cancellation and native stream backpressure.

createServiceClient(service, nativeClient) adapts a native grpc-js client. Driver.createClient returns that async service client. Use createPinnedClient to await endpoint pin acquisition explicitly. ClientCallOptions accepts native Metadata and grpc-js call options alongside signal, onHeader and onTrailer. Replace addClientMiddleware and CredentialsProvider.middleware with native addClientInterceptor and CredentialsProvider.interceptor. Metadata.get returns an array; server failures retain native ServiceError codes, details and trailers. Query metadata events carry native Metadata.

High-level TopicWriter, TopicReader, query and coordination operations retain their APIs. Custom service definitions use the native grpc-js ServiceDefinition format.

Per-call interceptors and interceptor providers preserve the driver authentication and metadata chain. Cancelled response streams reject with the caller reason before delivering further buffered responses.
