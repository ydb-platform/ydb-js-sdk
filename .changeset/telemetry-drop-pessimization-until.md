---
'@ydbjs/telemetry': minor
---

Drop the `pessimization.until` span-event attribute from the `ydb:driver.connection.pessimized` subscriber. The endpoints engine in `@ydbjs/core` no longer emits `until` (pessimization has no fixed timer), so the subscriber was writing `NaN` (`undefined / 1000`) as the attribute value under an active span. The `ATTR_YDB_DRIVER_CONNECTION_PESSIMIZATION_UNTIL` semconv constant is kept but deprecated.

Add the `ydb.node.pile` (`ATTR_YDB_NODE_PILE`) span-event attribute to every `ydb:driver.connection.*` mapping, so bridge (2DC) traces show which pile each node belongs to alongside `ydb.node.dc`. The attribute is omitted on a non-bridge cluster (empty pile name).

Map the remaining bridge (2DC) topology channels emitted by `@ydbjs/core`:

- **Traces.** The `ydb:driver.discovery.completed` mapping now also sets `ydb.discovery.self_location` and `ydb.discovery.primary_pile` on the `ydb.Discovery` span. A new `ydb:driver.pile.changed` mapping records a `ydb.driver.pile.changed` span event (with `ydb.driver.pile.primary_before` / `primary_after`) on the discovery span it fires within. Both are absent on a non-bridge cluster.
- **Metrics.** New observable gauges reconstruct the routing snapshot from `ydb:driver.connection.pool.stats`: `ydb.driver.pool.routable` (tagged `ydb.routing.tier` ∈ {`prefer`, `fallback`}, plus the `ydb.routing.prefer_primary_pile` / `ydb.routing.locality_enabled` mode folded in from `ydb:driver.connection.pool.opened`), `ydb.driver.pool.pessimized`, and `ydb.driver.pool.nodes` (per bridge pile, tagged `ydb.pile.name` / `ydb.pile.status`). Two counters track pile transitions: `ydb.driver.pile.fallbacks` (tagged `ydb.pile.fallback.active`) from `ydb:driver.pile.fallback`, and `ydb.driver.pile.changes` from `ydb:driver.pile.changed`. All are keyed by driver identity and cleared on `ydb:driver.closed`.
