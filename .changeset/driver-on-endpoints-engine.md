---
'@ydbjs/core': major
---

Rebuild `Driver`'s connection layer on a new, internal endpoints engine (a pure `@ydbjs/fsm` state machine for discovery/routing/health plus an `EndpointPool` facade with a synchronous, allocation-light `acquire()` that reads an atomically-swapped immutable `RoutingSnapshot`), replacing the legacy `ConnectionPool`. The engine is an implementation detail — consumers only ever hold a `Driver` — so it is **not** exported from the package root.

`Driver`'s public shape is preserved (`ready`, `close`, `token`, `database`, `identity`, `Disposable`/`AsyncDisposable`, `kRegisterLibrary`), and `createClient` gains direct-IO routing:

- `createClient(service)` — balanced across all healthy nodes.
- `createClient(service, nodeId)` — soft affinity to a node (node-bound query sessions).
- `createClient(service, { nodeId, endpoint?, hard? })` — direct-IO for topic direct read/write: `hard: true` routes every RPC to `nodeId` or fails (never substitutes); `endpoint` pins a server-named node (reachable before the next discovery round, e.g. a topic `PartitionLocation`). The returned client is `Disposable` and unpins on dispose.

Behavioural changes vs the old pool:

- **Balancing** is uniform-random within a locality tier (opt-in via `'ydb.sdk.locality_enabled'`, default off) instead of modulo round-robin, with O(1) node affinity.
- **Pessimization** has no fixed timer: a node is pessimized on `UNAVAILABLE`/`DEADLINE_EXCEEDED` and recovers on the next successful RPC or discovery round. The `ydb:driver.connection.pessimized` payload no longer carries `until`. `'ydb.sdk.connection_pessimization_timeout_ms'` is now ignored.
- **Rediscovery** adds degradation-triggered forced rounds and single-flight/backoff; each round is bounded by `'ydb.sdk.discovery_timeout_ms'` (a timed-out round is retryable, so a hung `listEndpoints` no longer wedges rediscovery). A retryable initial failure keeps retrying (only a non-retryable error is terminal and emits `ydb:driver.failed`); a round returning zero endpoints is retried instead of going ready with an empty routing table.
- **Connections** are dialed lazily and a node dropped from discovery is drained rather than torn down (a brief flap no longer forces a reconnect). `'ydb.sdk.connection_idle_timeout_ms'` now bounds the grace a retired channel is kept before reaping (no separate idle-active teardown). `close()` drains in-flight streams and returns as soon as they finish, capped by an internal close deadline, instead of always waiting that deadline.
- **New options:** `'ydb.sdk.locality_enabled'` (default `false`) and `'ydb.sdk.discovery_degraded_threshold'` (0..1, default `0.5`, validated).

The `ConnectionPool` class and the `POOL_*_FOR_TESTING` symbols are removed. All `diagnostics_channel` channel names and identity-stamped payloads are preserved (minus the `until` field on `connection.pessimized`); the round-derived events are published inside the `tracing:ydb:driver.discovery` span so `@ydbjs/telemetry` attaches them to traces. `EndpointsUnavailableError` and the `Driver*` option/connection-string error classes are re-exported from the package root.
