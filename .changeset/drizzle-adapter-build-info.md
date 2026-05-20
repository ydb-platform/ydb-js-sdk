---
'@ydbjs/drizzle-adapter': patch
---

Advertise the adapter in `x-ydb-sdk-build-info`. `YdbDriver` now registers `@ydbjs/drizzle-adapter/<version>` on the underlying `Driver` for both owned and borrowed instances, so server-side telemetry can attribute traffic to the adapter without losing the native SDK identity (which stays first in the header).
