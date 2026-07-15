# @ydbjs/core

## 7.0.0

### Major Changes

- [#638](https://github.com/ydb-platform/ydb-js-sdk/pull/638) [`807010c`](https://github.com/ydb-platform/ydb-js-sdk/commit/807010c6d784828b63676e351fd807ae0dd47338) Thanks [@polRk](https://github.com/polRk)! - Rebuild `Driver`'s connection layer on a new, internal endpoints engine (a pure `@ydbjs/fsm` state machine for discovery/routing/health plus an `EndpointPool` facade with a synchronous, allocation-light `acquire()` that reads an atomically-swapped immutable `RoutingSnapshot`), replacing the legacy `ConnectionPool`. The engine is an implementation detail — consumers only ever hold a `Driver` — so it is **not** exported from the package root.

  `Driver`'s public shape is preserved (`ready`, `close`, `token`, `database`, `identity`, `Disposable`/`AsyncDisposable`, `kRegisterLibrary`), and `createClient` gains direct-IO routing:
  - `createClient(service)` — balanced across all healthy nodes.
  - `createClient(service, nodeId)` — soft affinity to a node (node-bound query sessions).
  - `createClient(service, { nodeId, endpoint?, hard? })` — direct-IO for topic direct read/write: `hard: true` routes every RPC to `nodeId` or fails (never substitutes); `endpoint` pins a server-named node (reachable before the next discovery round, e.g. a topic `PartitionLocation`). The returned client is `Disposable` and unpins on dispose.

  Behavioural changes vs the old pool:
  - **Balancing** is uniform-random within a locality tier (opt-in via `'ydb.sdk.locality_enabled'`, default off) instead of modulo round-robin, with O(1) node affinity.
  - **Pessimization** has no fixed timer: a node is pessimized on `UNAVAILABLE`/`DEADLINE_EXCEEDED` and recovers on the next successful RPC or discovery round. The `ydb:driver.connection.pessimized` payload no longer carries `until`. `'ydb.sdk.connection_pessimization_timeout_ms'` is now ignored.
  - **Rediscovery** adds degradation-triggered forced rounds and single-flight/backoff; each round is bounded by `'ydb.sdk.discovery_timeout_ms'` (a timed-out round is retryable, so a hung `listEndpoints` no longer wedges rediscovery). A retryable initial failure keeps retrying (only a non-retryable error is terminal and emits `ydb:driver.failed`); a round returning zero endpoints is rejected as a retryable failure in every state — never applied to routing, so a one-round LB glitch cannot wipe the endpoint set.
  - **Connections** are dialed lazily and a node dropped from discovery is drained rather than torn down (a brief flap no longer forces a reconnect). `'ydb.sdk.connection_idle_timeout_ms'` now bounds the grace a retired channel is kept before reaping (no separate idle-active teardown). A graceful shutdown (`await using driver` / `[Symbol.asyncDispose]`) drains in-flight streams and returns as soon as they finish, capped by an internal close deadline; the synchronous `close()` tears everything down immediately.
  - **Bridge (2DC) piles:** on a bridge cluster, routing is restricted to endpoints whose pile is `PRIMARY`, `PROMOTED`, or `SYNCHRONIZED` (other pile states are kept out of the balancing tiers, used only as a last resort when every pile is unusable). Opt-in `'ydb.sdk.prefer_primary_pile'` (default `false`) additionally keeps traffic on the `PRIMARY`/`PROMOTED` pile, falling back to `SYNCHRONIZED` only when the primary has no available node. It is soft (fallback preserved), a no-op on a non-bridge cluster, and takes precedence over `'ydb.sdk.locality_enabled'` in bridge mode (a pile already maps to a datacenter, so the two are not combined).
  - **Bridge/pool observability:** every `ydb:driver.connection.*` event now carries the endpoint's `pile` (`''` on a non-bridge cluster), and `DriverHooks`' `EndpointInfo` gains a `pile` field. `ydb:driver.discovery.completed` additionally carries `selfLocation`, the pile roster (`piles: { name, status }[]`), and `primaryPile`. New channels: `ydb:driver.connection.pool.opened` (one-shot config snapshot), `ydb:driver.connection.pool.stats` (aggregate tier/pile counts on every routable-set change), `ydb:driver.pile.changed` (pile roster/primary change, inside the discovery span), and `ydb:driver.pile.fallback` (edge-triggered when `preferPrimaryPile` serves from the SYNCHRONIZED tier).
  - **New options:** `'ydb.sdk.locality_enabled'` (default `false`), `'ydb.sdk.prefer_primary_pile'` (default `false`), and `'ydb.sdk.discovery_degraded_threshold'` (0..1, default `0.5`, validated).

  The `ConnectionPool` class and the `POOL_*_FOR_TESTING` symbols are removed. All `diagnostics_channel` channel names and identity-stamped payloads are preserved (minus the `until` field on `connection.pessimized`); the round-derived events are published inside the `tracing:ydb:driver.discovery` span so `@ydbjs/telemetry` attaches them to traces. `EndpointsUnavailableError` and the `Driver*` option/connection-string error classes are re-exported from the package root.

### Patch Changes

- [#635](https://github.com/ydb-platform/ydb-js-sdk/pull/635) [`65ba0fd`](https://github.com/ydb-platform/ydb-js-sdk/commit/65ba0fdf81aaaa880699633b005e1cf134f226a8) Thanks [@polRk](https://github.com/polRk)! - Fix process crash when a background rediscovery round fails. The periodic discovery loop scheduled its rounds as floating promises, so a terminally failed round (e.g. the discovery endpoint dropping mid-round until the per-round timeout aborted the retries) escalated to an `unhandledRejection` and killed the process. Failed background rounds are now caught and logged; the connection pool keeps serving last-known endpoints and the next interval tick retries.

- Updated dependencies [[`5d0cc28`](https://github.com/ydb-platform/ydb-js-sdk/commit/5d0cc2869176b222a6c12e6f3455a530178599be), [`6c3dee3`](https://github.com/ydb-platform/ydb-js-sdk/commit/6c3dee3e5a84c666c3425cac779e18adc53be2b1)]:
  - @ydbjs/api@7.0.0
  - @ydbjs/fsm@7.0.0
  - @ydbjs/auth@6.3.2
  - @ydbjs/error@6.0.7
  - @ydbjs/retry@6.3.1

## 6.3.1

### Patch Changes

- [#623](https://github.com/ydb-platform/ydb-js-sdk/pull/623) [`f78bc01`](https://github.com/ydb-platform/ydb-js-sdk/commit/f78bc017482c2acb60a28f12c83eebd21569de63) Thanks [@polRk](https://github.com/polRk)! - Bump `@bufbuild/protobuf` from `2.10.1` to `2.12.0`.

- Updated dependencies [[`f78bc01`](https://github.com/ydb-platform/ydb-js-sdk/commit/f78bc017482c2acb60a28f12c83eebd21569de63)]:
  - @ydbjs/api@6.0.7
  - @ydbjs/auth@6.3.1
  - @ydbjs/error@6.0.6

## 6.3.0

### Minor Changes

- [#617](https://github.com/ydb-platform/ydb-js-sdk/pull/617) [`3a661c5`](https://github.com/ydb-platform/ydb-js-sdk/commit/3a661c5e1803fb89a604a5332e142990558c7691) Thanks [@polRk](https://github.com/polRk)! - Let libraries layered on top of the SDK advertise themselves in the `x-ydb-sdk-build-info` header.

  Frameworks (e.g. `@ydbjs/drizzle-adapter`) call `driver[kRegisterLibrary](name, version)` after constructing or borrowing a `Driver`. Registered entries are appended after the native `ydb-js-sdk/<version>` token, separated by `;`, matching the server-side parser which keys off the leading native SDK token. Repeated registrations of the same `name/version` are deduplicated; the header string is built once per registration so the per-RPC middleware just reads a cached field.

  ```ts
  import { Driver, kRegisterLibrary } from '@ydbjs/core'

  let driver = new Driver(connectionString)
  driver[kRegisterLibrary]('@ydbjs/drizzle-adapter', '0.1.0')
  // x-ydb-sdk-build-info: ydb-js-sdk/6.2.0;@ydbjs/drizzle-adapter/0.1.0
  ```

## 6.2.0

### Minor Changes

- [#599](https://github.com/ydb-platform/ydb-js-sdk/pull/599) [`efa7adf`](https://github.com/ydb-platform/ydb-js-sdk/commit/efa7adf9e1346388a4358f3e1bf8a8ac5c85419b) Thanks [@polRk](https://github.com/polRk)! - Publish driver, discovery, and connection-pool events on `node:diagnostics_channel` so external subscribers can build traces, metrics, and logs.

  New channels:
  - `ydb:driver.ready`, `ydb:driver.failed`, `ydb:driver.closed` — driver lifecycle.
  - `tracing:ydb:discovery` — discovery round span.
  - `ydb:discovery.completed` — per-round delta.
  - `ydb:pool.connection.added`, `pessimized`, `unpessimized`, `retired`, `removed` — connection-pool state changes.

  Channel names and payload fields are part of the public API. See `packages/core/README.md` for the full table and a warning about safe subscribers (DC publishes synchronously — a throwing subscriber will disrupt the SDK).

- [#609](https://github.com/ydb-platform/ydb-js-sdk/pull/609) [`17d1020`](https://github.com/ydb-platform/ydb-js-sdk/commit/17d10200b0dbd1dd0d48041bf377f91dc1a15d75) Thanks [@polRk](https://github.com/polRk)! - OpenTelemetry metrics pipeline, semantic-convention cleanup, a `DeleteSession` span, and W3C trace context propagation in `@ydbjs/core`.

  `@ydbjs/telemetry`:
  - Attribute / event / metric constants are split across `src/semconv/{common,spans,events,metrics}.ts`. The old `src/attributes.ts` is gone; unused `ATTR_YDB_POOL_*` keys (`max_size`, `creating`, `live_sessions`) were dead and have been removed.
  - Connection-pool event names are now component-scoped: `ydb.pool.connection.*` → `ydb.driver.connection.*`. Same for `ATTR_YDB_POOL_*` → `ATTR_YDB_DRIVER_CONNECTION_*` (used as `addEvent` attributes).
  - `db.operation.name` carries a service prefix (`Query.ExecuteQuery`, `Query.BeginTransaction`, `Discovery.ListEndpoints`, ...) so traces stay unambiguous if the Table service is instrumented alongside Query later.
  - Time values: `node:diagnostics_channel` payloads stay in milliseconds (Node convention — `performance.now()` and `Date.now()` units). The OTel mapping divides by 1000 when assigning to attributes / metric data points, whose semantic unit is seconds. Attribute keys no longer carry the `_ms` suffix (e.g. `ydb.retry.backoff`, `ydb.discovery.duration`).
  - A new `ydb.DeleteSession` span (channel `tracing:ydb:query.session.delete`) wraps the per-session `DeleteSession` RPC, with `db.operation.name="Query.DeleteSession"`, `ydb.session.id`, `ydb.node.id`, `ydb.session.close.reason`, `ydb.session.uptime`.
  - Metrics pipeline (first cut) registers the following synchronous instruments via the package's OTel `Meter`:
    - `db.client.operation.duration` (Histogram, `s`) — emitted on every leaf CLIENT tracing channel, tagged with `db.operation.name`. Standard OTel database metric so off-the-shelf dashboards work out of the box.
    - `ydb.driver.connection.pessimizations` (Counter)
    - `ydb.query.session.create.duration` / `ydb.query.session.acquire.duration` (Histogram)
    - `ydb.query.session.closed` (Counter, tagged with `ydb.session.close.reason`)
    - `ydb.auth.token.fetch.duration` (Histogram), `ydb.auth.token.fetch.failures` (Counter), `ydb.auth.token.expirations` (Counter)
    - `ydb.retry.attempts` (Counter, tagged with `ydb.retry.outcome`), `ydb.retry.duration` (Histogram, end-to-end including backoffs)
  - Two observable instruments are also emitted, fed by an internal per-`DriverIdentity` state registry that subscribes to existing lifecycle events:
    - `ydb.driver.connection.count` (`ObservableUpDownCounter`, tagged with `ydb.connection.state` ∈ `{live, pessimized}`)
    - `ydb.query.session.count` (`ObservableUpDownCounter`, total only — state breakdown is a follow-up that needs `session.acquired/released` events from `@ydbjs/query`)
  - W3C trace context propagation: `register()` installs a gRPC client middleware (via `@ydbjs/core`'s new `addClientMiddleware`) that calls `propagation.inject(context.active(), metadata, …)` on every outgoing YDB RPC. Always on while the instrumentation is enabled — without an OTel SDK the global propagator is a no-op. Must be called before `new Driver(...)` for the middleware to apply.

  `@ydbjs/query`:
  - `SessionPool` accepts a new `minSize?: number` option (default `0`) — reported as `ydb.query.session.min` once that observable is wired up. No eager session pre-warm is performed today; the option exists for parity with other YDB SDKs and for future warm-up logic.
  - `ydb:query.session.pool.opened` payload now includes `minSize`.
  - `Session.close()` accepts a `SessionCloseReason` (`pool_close` | `attach_failed` | `stream_closed` | `stream_error`). The `DeleteSession` RPC is now published via `tracingChannel('tracing:ydb:query.session.delete')` so subscribers see a span around each background delete, with the reason on the context.
  - Session uptime is tracked on the `Session` itself (`readonly createdAt`) instead of in a parallel `WeakMap` inside the pool.

  `@ydbjs/retry`:
  - New `ydb:retry.attempt.completed` event published after every attempt, with `{ attempt, idempotent, outcome }` where `outcome` is `'success' | 'retried' | 'non_retryable' | 'exhausted'`. Feeds the `ydb.retry.attempts` counter.
  - `tracing:ydb:retry.run` context now carries an `outcome` field (set by the runner before resolve / throw) so subscribers can tag end-to-end retry duration histograms by outcome.

  `@ydbjs/core`:
  - `ydb:driver.connection.unpessimized` payload field is `duration` (ms).
  - New `addClientMiddleware(mw)` API — appends a `ClientMiddleware` to a
    process-global registry that `Driver` composes into its gRPC client chain
    at construction time. Returns a `Disposable` for cleanup. Used by
    `@ydbjs/telemetry` to install W3C trace context propagation without
    pulling OTel packages into `@ydbjs/core`. Drivers constructed before the
    registration do not pick up the new middleware — call before
    `new Driver(...)`.

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

- Updated dependencies [[`c388ccc`](https://github.com/ydb-platform/ydb-js-sdk/commit/c388cccef45a6f5c6ba325df7f80d9b8337b156b), [`fa32650`](https://github.com/ydb-platform/ydb-js-sdk/commit/fa32650b5393052e5802126f114355b9d3720448), [`b8b5ef5`](https://github.com/ydb-platform/ydb-js-sdk/commit/b8b5ef56b600cec4261680a5b211f4c2dd81259f), [`17d1020`](https://github.com/ydb-platform/ydb-js-sdk/commit/17d10200b0dbd1dd0d48041bf377f91dc1a15d75)]:
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
