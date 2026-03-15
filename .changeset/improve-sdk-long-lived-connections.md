---
'@ydbjs/core': minor
---

Redesign connection management for long-lived connections

- Replace LazyConnection with GrpcConnection (eager channel, Disposable pattern)
- Replace Proxy-based routing with BalancedChannel for proper load balancing
- Rework ConnectionPool: array-based round-robin, Map pessimization
- Add sync() for atomic discovery updates — stale endpoints removed without closing active channels (existing streams continue)
- Add isAvailable(nodeId) for future session pool integration
- Add DriverTelemetryHooks (onCall, onPessimize, onUnpessimize, onDiscovery, onDiscoveryError) with AsyncLocalStorage context preservation for OpenTelemetry compatibility
- Extract driver-specific errors to separate module
- Tune keepalive: 30s → 10s (worst-case detection: 35s → 15s)
- Remove abort-controller-x dependency, use native AbortError
