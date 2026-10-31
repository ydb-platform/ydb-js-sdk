# @ydbjs/api

## 7.0.0

### Major Changes

- [#638](https://github.com/ydb-platform/ydb-js-sdk/pull/638) [`5d0cc28`](https://github.com/ydb-platform/ydb-js-sdk/commit/5d0cc2869176b222a6c12e6f3455a530178599be) Thanks [@polRk](https://github.com/polRk)! - Regenerate the protobuf types with the bridge / multi-pile (2-DC) API: `EndpointInfo.bridge_pile_name`, `ListEndpointsResult.pile_states`, `NodeLocation.bridge_pile_name`, and a new `@ydbjs/api/bridge` export exposing `PileState` / `PileState_State`. Also pick up newer upstream fields in discovery / query / topic / monitoring.

  **Breaking:** codegen moves to `protoc-gen-es` 2.12.x (aligned with the `@bufbuild/protobuf` 2.12 runtime), which honours `exactOptionalPropertyTypes`: optional message fields are now typed `T | undefined` instead of `T`. Consumers compiled with `exactOptionalPropertyTypes` that mirror generated optional fields into their own optional-typed fields must accept `undefined` (a type-level break, no behavioural change).

- [`a389fc4`](https://github.com/ydb-platform/ydb-js-sdk/commit/a389fc49a435b0a2686f0085b00f663d07f98096) Thanks [@polRk](https://github.com/polRk)! - Connect SDK services to `@ydbjs/grpc` and remove nice-grpc and grpc-js from the workspace. Service methods retain Promise results and AsyncIterable request/response streams, with AbortSignal cancellation and backpressure. Requires Node.js 22.15 or later supported by the SDK.

  Use `createServiceClient(service, transport)` for standalone calls. `Driver.createClient` retains discovery and node selection; `createPinnedClient` explicitly awaits endpoint pin acquisition. Configure TLS, message limits, and HTTP/2 windows through `transportOptions`. The transport does not replay RPCs or duplicate YDB balancing and retry policies.

  Call options accept plain metadata records, signals, absolute deadlines, and header/trailer/status observers. `RpcError` carries code, details, and trailing metadata; `MessageSizeError` identifies permanent local size-limit failures. Query metadata events expose the same record format. Register `addMetadataHook` before constructing Driver to add tracing headers. Credential providers supply `getToken`; Driver handles authentication and mandatory headers without middleware or interceptor adapters.

  High-level TopicWriter, TopicReader, query, and coordination operations retain their APIs. Generated API definitions remain independent of the transport at runtime. Request framing sends the header and serialized body separately, avoiding the payload copy used to prepend a gRPC frame header.

  Preserve explicit TLS server names when discovery provides no override, and avoid logging raw driver options.

  Preserve explicit gRPC endpoint ports when selecting TLS, including mixed-case URL schemes. Merge repeated case-insensitive call metadata values while keeping required driver headers authoritative over caller metadata and hooks.

### Patch Changes

- [#666](https://github.com/ydb-platform/ydb-js-sdk/pull/666) [`a4022e4`](https://github.com/ydb-platform/ydb-js-sdk/commit/a4022e4f218fa49d12796435f8722f7acd8b3d28) Thanks [@polRk](https://github.com/polRk)! - Upgrade protobuf to 2.16.0 to reduce temporary allocations during serialization and parsing.

## 6.0.7

### Patch Changes

- [#623](https://github.com/ydb-platform/ydb-js-sdk/pull/623) [`f78bc01`](https://github.com/ydb-platform/ydb-js-sdk/commit/f78bc017482c2acb60a28f12c83eebd21569de63) Thanks [@polRk](https://github.com/polRk)! - Bump `@bufbuild/protobuf` from `2.10.1` to `2.12.0`.

## 6.0.6

### Patch Changes

- [#559](https://github.com/ydb-platform/ydb-js-sdk/pull/559) [`ff96fe6`](https://github.com/ydb-platform/ydb-js-sdk/commit/ff96fe6a731269be1d093f60970a0b926c103076) Thanks [@vgvoleg](https://github.com/vgvoleg)! - Sync latest protospecs

## 6.0.5

### Patch Changes

- Reduce npm package size by limiting published files to dist, README.md, and CHANGELOG.md only

## 6.0.4

### Patch Changes

- cb0db2f: Update dependencies

## 6.0.3

## 6.0.2

## 6.0.1
