# @ydbjs/coordination

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
