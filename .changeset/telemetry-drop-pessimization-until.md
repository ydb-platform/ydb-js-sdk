---
'@ydbjs/telemetry': patch
---

Drop the `pessimization.until` span-event attribute from the `ydb:driver.connection.pessimized` subscriber. The endpoints engine in `@ydbjs/core` no longer emits `until` (pessimization has no fixed timer), so the subscriber was writing `NaN` (`undefined / 1000`) as the attribute value under an active span. The `ATTR_YDB_DRIVER_CONNECTION_PESSIMIZATION_UNTIL` semconv constant is kept but deprecated.
