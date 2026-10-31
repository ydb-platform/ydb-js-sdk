# @ydbjs/coordination

## 7.0.0

### Major Changes

- [`a389fc4`](https://github.com/ydb-platform/ydb-js-sdk/commit/a389fc49a435b0a2686f0085b00f663d07f98096) Thanks [@polRk](https://github.com/polRk)! - Connect SDK services to `@ydbjs/grpc` and remove nice-grpc and grpc-js from the workspace. Service methods retain Promise results and AsyncIterable request/response streams, with AbortSignal cancellation and backpressure. Requires Node.js 22.15 or later supported by the SDK.

  Use `createServiceClient(service, transport)` for standalone calls. `Driver.createClient` retains discovery and node selection; `createPinnedClient` explicitly awaits endpoint pin acquisition. Configure TLS, message limits, and HTTP/2 windows through `transportOptions`. The transport does not replay RPCs or duplicate YDB balancing and retry policies.

  Call options accept plain metadata records, signals, absolute deadlines, and header/trailer/status observers. `RpcError` carries code, details, and trailing metadata; `MessageSizeError` identifies permanent local size-limit failures. Query metadata events expose the same record format. Register `addMetadataHook` before constructing Driver to add tracing headers. Credential providers supply `getToken`; Driver handles authentication and mandatory headers without middleware or interceptor adapters.

  High-level TopicWriter, TopicReader, query, and coordination operations retain their APIs. Generated API definitions remain independent of the transport at runtime. Request framing sends the header and serialized body separately, avoiding the payload copy used to prepend a gRPC frame header.

  Preserve explicit TLS server names when discovery provides no override, and avoid logging raw driver options.

  Preserve explicit gRPC endpoint ports when selecting TLS, including mixed-case URL schemes. Merge repeated case-insensitive call metadata values while keeping required driver headers authoritative over caller metadata and hooks.

### Patch Changes

- [#703](https://github.com/ydb-platform/ydb-js-sdk/pull/703) [`5c0f0c2`](https://github.com/ydb-platform/ydb-js-sdk/commit/5c0f0c2b59c561a5eb2a4e64f81080ae8ba640db) Thanks [@polRk](https://github.com/polRk)! - Stop coordination sessions immediately on destroy, clear pending watch notifications and timers, and reject further operations. Support synchronous disposal while preserving graceful close and async disposal through SessionStop acknowledgment. Preserve acknowledged semaphore ownership when only the acquisition's caller signal is cancelled; return its lease for explicit release or disposal.

- [#666](https://github.com/ydb-platform/ydb-js-sdk/pull/666) [`a4022e4`](https://github.com/ydb-platform/ydb-js-sdk/commit/a4022e4f218fa49d12796435f8722f7acd8b3d28) Thanks [@polRk](https://github.com/polRk)! - Upgrade protobuf to 2.16.0 to reduce temporary allocations during serialization and parsing.

- [`ea3692f`](https://github.com/ydb-platform/ydb-js-sdk/commit/ea3692fc850072a84a8d812826786642ccc1b1c1) Thanks [@polRk](https://github.com/polRk)! - Refresh compatible dependency versions and remove unused runtime packages. Include the `ms` types required by the Topic reader's published declarations.
- Updated dependencies [[`1cb8668`](https://github.com/ydb-platform/ydb-js-sdk/commit/1cb8668cb014cf7603114666eb0f21064792eaa6), [`5d0cc28`](https://github.com/ydb-platform/ydb-js-sdk/commit/5d0cc2869176b222a6c12e6f3455a530178599be), [`cdff086`](https://github.com/ydb-platform/ydb-js-sdk/commit/cdff0864d850ba1bd1c7cf7c7041dd9742f04ef6), [`0edf569`](https://github.com/ydb-platform/ydb-js-sdk/commit/0edf569632df41da24e3a00d4ec5e141d914704a), [`64df3b5`](https://github.com/ydb-platform/ydb-js-sdk/commit/64df3b50005490e7c5a1628a6a9f31cb19e07d3d), [`807010c`](https://github.com/ydb-platform/ydb-js-sdk/commit/807010c6d784828b63676e351fd807ae0dd47338), [`65ba0fd`](https://github.com/ydb-platform/ydb-js-sdk/commit/65ba0fdf81aaaa880699633b005e1cf134f226a8), [`e6960f6`](https://github.com/ydb-platform/ydb-js-sdk/commit/e6960f6b4170c7d399739b364c45ed5ca8374eb4), [`549da21`](https://github.com/ydb-platform/ydb-js-sdk/commit/549da21a2f16312e5c774cb34ab4de87f40f3005), [`af97a85`](https://github.com/ydb-platform/ydb-js-sdk/commit/af97a858daea4a5a0a0df647abe19cf0f1e6bdb7), [`27bdd45`](https://github.com/ydb-platform/ydb-js-sdk/commit/27bdd45166b1e6b12bd7f83a559128cbb0f43ec1), [`0ca6e3a`](https://github.com/ydb-platform/ydb-js-sdk/commit/0ca6e3a44991d9aceedca3d777d86d1c8c3f9aae), [`6c3dee3`](https://github.com/ydb-platform/ydb-js-sdk/commit/6c3dee3e5a84c666c3425cac779e18adc53be2b1), [`0edf569`](https://github.com/ydb-platform/ydb-js-sdk/commit/0edf569632df41da24e3a00d4ec5e141d914704a), [`031e586`](https://github.com/ydb-platform/ydb-js-sdk/commit/031e586337262eca797d5bbd013dc9c0fedc9f1b), [`dc41967`](https://github.com/ydb-platform/ydb-js-sdk/commit/dc419672abd79679b8f5d819067c374d9ff59208), [`986e841`](https://github.com/ydb-platform/ydb-js-sdk/commit/986e841781aebe4adb7d05a3deeeb105536fac93), [`a389fc4`](https://github.com/ydb-platform/ydb-js-sdk/commit/a389fc49a435b0a2686f0085b00f663d07f98096), [`b9342a1`](https://github.com/ydb-platform/ydb-js-sdk/commit/b9342a1648be7805047af2c15c43306998ee1726), [`9e16c2c`](https://github.com/ydb-platform/ydb-js-sdk/commit/9e16c2c2524658a1f56fdd465a317f4a2ae64846), [`a4022e4`](https://github.com/ydb-platform/ydb-js-sdk/commit/a4022e4f218fa49d12796435f8722f7acd8b3d28), [`ea3692f`](https://github.com/ydb-platform/ydb-js-sdk/commit/ea3692fc850072a84a8d812826786642ccc1b1c1), [`6ad8ff0`](https://github.com/ydb-platform/ydb-js-sdk/commit/6ad8ff016a40d9036add4d7db8dc5d0e6b8365de)]:
  - @ydbjs/abortable@6.2.0
  - @ydbjs/api@7.0.0
  - @ydbjs/core@7.0.0
  - @ydbjs/fsm@7.0.0
  - @ydbjs/grpc@0.2.0
  - @ydbjs/error@6.1.0
  - @ydbjs/debug@6.0.6

## 6.2.1

### Patch Changes

- [#623](https://github.com/ydb-platform/ydb-js-sdk/pull/623) [`f78bc01`](https://github.com/ydb-platform/ydb-js-sdk/commit/f78bc017482c2acb60a28f12c83eebd21569de63) Thanks [@polRk](https://github.com/polRk)! - Bump `@bufbuild/protobuf` from `2.10.1` to `2.12.0`.

- Updated dependencies [[`f78bc01`](https://github.com/ydb-platform/ydb-js-sdk/commit/f78bc017482c2acb60a28f12c83eebd21569de63)]:
  - @ydbjs/api@6.0.7
  - @ydbjs/core@6.3.1
  - @ydbjs/error@6.0.6

## 6.2.0

### Minor Changes

- [#578](https://github.com/ydb-platform/ydb-js-sdk/pull/578) [`96137cb`](https://github.com/ydb-platform/ydb-js-sdk/commit/96137cb138718902e83cc2539e8320492f9bdbf0) Thanks [@polRk](https://github.com/polRk)! - Refactor coordination session architecture and signal contracts
  - Clean up file structure: delete dead files (session-stream, session-utils), merge node-runtime into node.ts, move try-acquire to errors.ts, move transport FSM into session-state.ts
  - Fix signal ownership: session owns its own AbortController (not delegated to transport), lease owns its own AbortController (not linked to session)
  - Add typed error classes: SessionClosedError, SessionExpiredError, LeaseReleasedError, LeaderChangedError, ObservationEndedError — all exported for instanceof checks
  - Simplify Lease: single #releasePromise pattern, delegates release to Semaphore.release()
  - Simplify Mutex: Lock is now a type alias for Lease (was empty subclass)
  - Simplify Election: accepts Semaphore directly (no longer knows about transport)
  - Move client to SessionTransport constructor (was passed on every connect)
  - Remove emit_error effect (redundant with mark_expired)
  - Remove waitReady proxy from SessionRuntime (use transport.waitReady directly)
  - Use Promise.withResolvers throughout (project convention)
  - Add integration tests for session lifecycle, lease signals, and user signal cancellation
  - Add e2e tests for race conditions, misuse scenarios, and typed error contracts

## 6.1.0

### Minor Changes

- [#566](https://github.com/ydb-platform/ydb-js-sdk/pull/566) [`db52b29`](https://github.com/ydb-platform/ydb-js-sdk/commit/db52b293438265970beb90bea5d423c7afa82ad7) Thanks [@polRk](https://github.com/polRk)! - Add coordination package with distributed semaphores support
  - Implement coordination node management (create, alter, drop, describe)
  - Add distributed semaphores with acquire/release operations
  - Support automatic session lifecycle with keep-alive and reconnection
  - Provide `watch()` method with AsyncIterable for semaphore monitoring
  - Include automatic session recreation on session expiring
  - Add examples for leader election, service discovery, and configuration publication

### Patch Changes

- Updated dependencies [[`9f0f297`](https://github.com/ydb-platform/ydb-js-sdk/commit/9f0f29766a83626f649580611cc676dea9f89d38)]:
  - @ydbjs/fsm@6.1.0
