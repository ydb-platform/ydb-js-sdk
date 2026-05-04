---
'@ydbjs/core': minor
---

Publish driver, discovery, and connection-pool events on `node:diagnostics_channel` so external subscribers can build traces, metrics, and logs.

New channels:

- `ydb:driver.ready`, `ydb:driver.failed`, `ydb:driver.closed` — driver lifecycle.
- `tracing:ydb:discovery` — discovery round span.
- `ydb:discovery.completed` — per-round delta.
- `ydb:pool.connection.added`, `pessimized`, `unpessimized`, `retired`, `removed` — connection-pool state changes.

Channel names and payload fields are part of the public API. See `packages/core/README.md` for the full table and a warning about safe subscribers (DC publishes synchronously — a throwing subscriber will disrupt the SDK).
