# @ydbjs/grpc

## 0.2.0

### Minor Changes

- [`986e841`](https://github.com/ydb-platform/ydb-js-sdk/commit/986e841781aebe4adb7d05a3deeeb105536fac93) Thanks [@polRk](https://github.com/polRk)! - Add a standalone HTTP/2 gRPC client with Promise unary calls, AsyncIterable streams, deadlines, cancellation, metadata, TLS, backpressure, GOAWAY handling, and bounded framing. Request headers and bodies are written separately without an extra payload copy.

- [`b9342a1`](https://github.com/ydb-platform/ydb-js-sdk/commit/b9342a1648be7805047af2c15c43306998ee1726) Thanks [@polRk](https://github.com/polRk)! - Add a typed HTTP/2 gRPC server with Promise and AsyncIterable handlers, cancellation, deadlines, metadata, TLS, and backpressure. Synchronous disposal cancels active calls; explicit close drains accepted calls. Invalid response metadata fails only its RPC, and deadlines reset incomplete response messages instead of sending malformed gRPC responses.

- [#714](https://github.com/ydb-platform/ydb-js-sdk/pull/714) [`9e16c2c`](https://github.com/ydb-platform/ydb-js-sdk/commit/9e16c2c2524658a1f56fdd465a317f4a2ae64846) Thanks [@polRk](https://github.com/polRk)! - Distinguish local protocol failures and HTTP/2 transport failures from server gRPC statuses. Stop retrying deterministic message-size and encoding failures ([#586](https://github.com/ydb-platform/ydb-js-sdk/issues/586)), and require idempotency before retrying ambiguous INTERNAL statuses or transport overload resets. Preserve the caller's cancellation reason and notify retry observers for attempts without backoff.

### Patch Changes

- [`0edf569`](https://github.com/ydb-platform/ydb-js-sdk/commit/0edf569632df41da24e3a00d4ec5e141d914704a) Thanks [@polRk](https://github.com/polRk)! - Stop processing response trailers when a header observer closes or disposes the client. Report cancellation once and do not invoke trailer observers after shutdown.

- [`031e586`](https://github.com/ydb-platform/ydb-js-sdk/commit/031e586337262eca797d5bbd013dc9c0fedc9f1b) Thanks [@polRk](https://github.com/polRk)! - Preserve completed responses before malformed frame errors and after terminal trailers followed by HTTP/2 resets. Preserve repeated text trailer values. Reject service definitions with the reserved `close` method name and timer settings above Node's maximum delay.

- [`dc41967`](https://github.com/ydb-platform/ydb-js-sdk/commit/dc419672abd79679b8f5d819067c374d9ff59208) Thanks [@polRk](https://github.com/polRk)! - Terminate server connections through their owned sockets during immediate shutdown. Avoid destroying the same HTTP/2 session again while a peer cancellation is already closing it.

  Classify synthetic CANCEL during socket loss as UNAVAILABLE even before the runtime marks the HTTP/2 session destroyed. Preserve a server CANCEL on a healthy connection draining after graceful GOAWAY.

- Updated dependencies [[`1cb8668`](https://github.com/ydb-platform/ydb-js-sdk/commit/1cb8668cb014cf7603114666eb0f21064792eaa6)]:
  - @ydbjs/abortable@6.2.0
