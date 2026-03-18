# @ydbjs/coordination

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
