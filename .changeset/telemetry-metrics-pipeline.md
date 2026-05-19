---
'@ydbjs/query': minor
'@ydbjs/retry': minor
'@ydbjs/core': patch
---

OpenTelemetry metrics pipeline, semantic-convention cleanup, and a `DeleteSession` span.

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
