---
'@ydbjs/core': major
---

Rewrite `Driver` to run on the new endpoints engine and remove the legacy `ConnectionPool`. The public `Driver` surface is unchanged (`createClient(service, preferNodeId?)`, `ready`, `close`, `token`, `database`, `identity`, `Disposable`/`AsyncDisposable`, `kRegisterLibrary`), but the connection layer now behaves differently:

- **Balancing** is uniform-random within a locality tier (opt-in via `'ydb.sdk.locality_enabled'`) instead of modulo round-robin, with O(1) node affinity for node-bound sessions.
- **Pessimization** has no fixed timer: a node is pessimized on `UNAVAILABLE`/`DEADLINE_EXCEEDED` and recovers on the next successful RPC or discovery round. The `ydb:driver.connection.pessimized` payload no longer carries `until`. `'ydb.sdk.connection_pessimization_timeout_ms'` is now ignored.
- **Rediscovery** adds degradation-triggered forced rounds and single-flight/backoff; a retryable initial discovery failure now keeps retrying (only a non-retryable error is terminal and emits `ydb:driver.failed`).
- **Connections** are dialed lazily and a node dropped from discovery is drained rather than torn down (a brief flap no longer forces a reconnect).

The `ConnectionPool` class and the `POOL_*_FOR_TESTING` symbols are removed. All `diagnostics_channel` channel names and the identity-stamped payloads are preserved (minus the `until` field), so `@ydbjs/telemetry` and other subscribers keep working.
