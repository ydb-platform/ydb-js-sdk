# @ydbjs/core

## 6.2.0

### Minor Changes

- [#599](https://github.com/ydb-platform/ydb-js-sdk/pull/599) [`efa7adf`](https://github.com/ydb-platform/ydb-js-sdk/commit/efa7adf9e1346388a4358f3e1bf8a8ac5c85419b) Thanks [@polRk](https://github.com/polRk)! - Publish driver, discovery, and connection-pool events on `node:diagnostics_channel` so external subscribers can build traces, metrics, and logs.

  New channels:
  - `ydb:driver.ready`, `ydb:driver.failed`, `ydb:driver.closed` — driver lifecycle.
  - `tracing:ydb:discovery` — discovery round span.
  - `ydb:discovery.completed` — per-round delta.
  - `ydb:pool.connection.added`, `pessimized`, `unpessimized`, `retired`, `removed` — connection-pool state changes.

  Channel names and payload fields are part of the public API. See `packages/core/README.md` for the full table and a warning about safe subscribers (DC publishes synchronously — a throwing subscriber will disrupt the SDK).

### Patch Changes

- [#599](https://github.com/ydb-platform/ydb-js-sdk/pull/599) [`fa32650`](https://github.com/ydb-platform/ydb-js-sdk/commit/fa32650b5393052e5802126f114355b9d3720448) Thanks [@polRk](https://github.com/polRk)! - Follow-ups to the `node:diagnostics_channel` instrumentation:

  `@ydbjs/query` — new tracing channels around transaction control RPCs:
  - `tracing:ydb:query.begin` — `BeginTransaction`. Context: `{ sessionId, nodeId, isolation }`.
  - `tracing:ydb:query.commit` — `CommitTransaction`. Context: `{ sessionId, nodeId, txId }`.
  - `tracing:ydb:query.rollback` — `RollbackTransaction`. Context: `{ sessionId, nodeId, txId }`. Fire-and-forget — `start` always fires, `asyncEnd` may land after the surrounding `query.transaction.error`.

  `tracing:ydb:query.execute` is reserved for `ExecuteQuery` RPCs only; subscribers building per-statement metrics should not expect `query.execute` events for begin/commit/rollback.

  Bug fixes:
  - `@ydbjs/query` — releasing a checked-out session after `pool.close()` no longer publishes `ydb:session.closed` twice. The eviction listener is detached before `session.close()` fires its abort.
  - `@ydbjs/core` — `Driver.close()` now cancels in-flight discovery and rejects pending `ready()` waiters. `ydb:driver.ready` / `ydb:driver.failed` no longer fire after `ydb:driver.closed`.
  - `@ydbjs/core` — `pool.pessimize()` only publishes `ydb:pool.connection.pessimized` (and calls the `onPessimize` hook) on the active→pessimized transition. Repeated pessimize calls that just refresh the timeout are now silent, so subscribers reconstructing pool state from delta events don't see phantom transitions.

  Documentation contract clarifications (no behavior change, but subscribers built from the previous wording were wrong):
  - `@ydbjs/retry` — `tracing:ydb:retry.attempt.error` fires for **every** failed attempt, including the final non-retried one. The README previously implied it fires only for attempts that will be retried.
  - `@ydbjs/auth` — the `provider` field is an open string set (custom `CredentialsProvider` implementations may contribute new values), not an enum. Subscribers should treat it as a label rather than write exhaustive switches.

- Updated dependencies [[`c388ccc`](https://github.com/ydb-platform/ydb-js-sdk/commit/c388cccef45a6f5c6ba325df7f80d9b8337b156b), [`fa32650`](https://github.com/ydb-platform/ydb-js-sdk/commit/fa32650b5393052e5802126f114355b9d3720448), [`b8b5ef5`](https://github.com/ydb-platform/ydb-js-sdk/commit/b8b5ef56b600cec4261680a5b211f4c2dd81259f)]:
  - @ydbjs/auth@6.3.0
  - @ydbjs/retry@6.3.0

## 6.1.1

### Patch Changes

- [#590](https://github.com/ydb-platform/ydb-js-sdk/pull/590) [`5c54025`](https://github.com/ydb-platform/ydb-js-sdk/commit/5c54025de89a475f6cdbb81308c9dd106224e33a) Thanks [@vgvoleg](https://github.com/vgvoleg)! - Add x-ydb-sdk-build-info gRPC header to all requests

## 6.1.0

### Minor Changes

- [#573](https://github.com/ydb-platform/ydb-js-sdk/pull/573) [`421fe42`](https://github.com/ydb-platform/ydb-js-sdk/commit/421fe42a78fb5d00667497a130f8343394f4a31d) Thanks [@polRk](https://github.com/polRk)! - Redesign connection management for long-lived connections
  - Replace LazyConnection with GrpcConnection (eager channel, Disposable pattern)
  - Replace Proxy-based routing with BalancedChannel for proper load balancing
  - Rework ConnectionPool: array-based round-robin, Map pessimization
  - Add sync() for atomic discovery updates — stale endpoints removed without closing active channels (existing streams continue)
  - Add isAvailable(nodeId) for future session pool integration
  - Add DriverTelemetryHooks (onCall, onPessimize, onUnpessimize, onDiscovery, onDiscoveryError) with AsyncLocalStorage context preservation for OpenTelemetry compatibility
  - Extract driver-specific errors to separate module
  - Tune keepalive: 30s → 10s (worst-case detection: 35s → 15s)
  - Remove abort-controller-x dependency, use native AbortError

## 6.0.7

### Patch Changes

- Fix discovery client undefined check

## 6.0.6

### Patch Changes

- Fix memory leaks in Driver class

## 6.0.5

### Patch Changes

- Reduce npm package size by limiting published files to dist, README.md, and CHANGELOG.md only
- Updated dependencies
  - @ydbjs/abortable@6.0.5
  - @ydbjs/api@6.0.5
  - @ydbjs/auth@6.0.5
  - @ydbjs/debug@6.0.5
  - @ydbjs/error@6.0.5
  - @ydbjs/retry@6.0.5

## 6.0.4

### Patch Changes

- cb0db2f: Update dependencies
- Updated dependencies [cb0db2f]
  - @ydbjs/debug@6.0.4
  - @ydbjs/error@6.0.4
  - @ydbjs/retry@6.0.4
  - @ydbjs/auth@6.0.4
  - @ydbjs/api@6.0.4
  - @ydbjs/abortable@6.0.4

## 6.0.3

### Patch Changes

- @ydbjs/abortable@6.0.3
- @ydbjs/api@6.0.3
- @ydbjs/auth@6.0.3
- @ydbjs/debug@6.0.3
- @ydbjs/error@6.0.3
- @ydbjs/retry@6.0.3

## 6.0.2

### Patch Changes

- @ydbjs/abortable@6.0.2
- @ydbjs/api@6.0.2
- @ydbjs/auth@6.0.2
- @ydbjs/debug@6.0.2
- @ydbjs/error@6.0.2
- @ydbjs/retry@6.0.2

## 6.0.1

### Patch Changes

- @ydbjs/abortable@6.0.1
- @ydbjs/api@6.0.1
- @ydbjs/auth@6.0.1
- @ydbjs/debug@6.0.1
- @ydbjs/error@6.0.1
- @ydbjs/retry@6.0.1
