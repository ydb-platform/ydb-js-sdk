---
'@ydbjs/telemetry': patch
---

Drop the `pessimization.until` span-event attribute from the `ydb:driver.connection.pessimized` subscriber. The endpoints engine in `@ydbjs/core` no longer emits `until` (pessimization has no fixed timer), so the subscriber was writing `NaN` (`undefined / 1000`) as the attribute value under an active span. The `ATTR_YDB_DRIVER_CONNECTION_PESSIMIZATION_UNTIL` semconv constant is kept but deprecated.

Add the `ydb.node.pile` (`ATTR_YDB_NODE_PILE`) span-event attribute to every `ydb:driver.connection.*` mapping, so bridge (2DC) traces show which pile each node belongs to alongside `ydb.node.dc`. The attribute is omitted on a non-bridge cluster (empty pile name).
