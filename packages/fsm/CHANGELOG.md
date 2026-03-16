# @ydbjs/fsm

## 6.1.1

### Patch Changes

- [`85df091`](https://github.com/ydb-platform/ydb-js-sdk/commit/85df0919b73532791c479fa8c2b397bfc8b8bab8) Thanks [@polRk](https://github.com/polRk)! - Fix memory leak in event ingestion caused by `AbortSignal.any()`

  `AbortSignal.any()` registers event listeners on all source signals but never removes them, leading to a listener leak every time an event source is ingested. Replace it with `linkSignals` from `@ydbjs/abortable@^6.1.0`, which uses `Symbol.dispose` to clean up listeners when the ingestion task completes.

  Additional improvements:
  - Use `combined.signal` instead of `combined` directly for abort checks (correct API usage)
  - Separate abort signal checks from internal state checks for better readability and clearer control flow

## 6.1.0

### Minor Changes

- [#566](https://github.com/ydb-platform/ydb-js-sdk/pull/566) [`9f0f297`](https://github.com/ydb-platform/ydb-js-sdk/commit/9f0f29766a83626f649580611cc676dea9f89d38) Thanks [@polRk](https://github.com/polRk)! - Add new `@ydbjs/fsm` runtime package for async-first finite state machines in YDB JS SDK.
  - Introduce reusable runtime with single-writer event processing
  - Support typed transitions and effect handler maps
  - Add async source ingestion and runtime output as `AsyncIterable`
  - Add lifecycle controls: `close` (graceful) and `destroy` (hard shutdown)
  - Add package tests, design document, and runnable example in `examples/fsm`
