# @ydbjs/fsm

## 6.1.0

### Minor Changes

- [#566](https://github.com/ydb-platform/ydb-js-sdk/pull/566) [`9f0f297`](https://github.com/ydb-platform/ydb-js-sdk/commit/9f0f29766a83626f649580611cc676dea9f89d38) Thanks [@polRk](https://github.com/polRk)! - Add new `@ydbjs/fsm` runtime package for async-first finite state machines in YDB JS SDK.
  - Introduce reusable runtime with single-writer event processing
  - Support typed transitions and effect handler maps
  - Add async source ingestion and runtime output as `AsyncIterable`
  - Add lifecycle controls: `close` (graceful) and `destroy` (hard shutdown)
  - Add package tests, design document, and runnable example in `examples/fsm`
