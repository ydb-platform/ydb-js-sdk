# @ydbjs/core

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
