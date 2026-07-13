---
'@ydbjs/core': minor
---

Add a reference-grade endpoints engine (`src/endpoints/`) built on `@ydbjs/fsm`: a pure discovery/routing/health state machine plus an `EndpointPool` facade with a synchronous, allocation-light `acquire()` that reads an immutable, atomically-swapped `RoutingSnapshot` (RCU). New public surface: `createEndpointsRuntime`, `EndpointPool`, `selectEndpoint`, `buildSnapshot`, `mapDiscoveryResult`, and their types. It brings uniform-random balancing within a locality tier, O(1) node affinity, lazy connect with churn-avoiding retired-connection handling, timer-free pessimization (optimistic un-ban + discovery reset), degradation-forced rediscovery, direct-IO node pinning (`pin` / `acquireNode({hard})` / `invalidate`), and bridge/multi-pile-aware selection (pile-health filter over `ListEndpointsResult.pile_states`). This module is standalone and not yet wired into `Driver`; the existing `Driver`/pool remain unchanged.
