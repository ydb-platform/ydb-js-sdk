# @ydbjs/telemetry

## 6.0.0

### Major Changes

- Initial release. OpenTelemetry instrumentation for the YDB JavaScript SDK.

  The package subscribes to `node:diagnostics_channel` events published by
  `@ydbjs/core`, `@ydbjs/query`, `@ydbjs/auth`, and `@ydbjs/retry`, and
  emits OpenTelemetry **spans** and **metrics** through the SDK's standard
  `TracerProvider` and `MeterProvider`. No monkey-patching — all
  instrumentation flows through diagnostics channels. Producers use
  `tracingChannel.tracePromise`, which short-circuits when no one is
  listening, so the package is zero-cost when disabled.

  **Lifecycle.** `YdbInstrumentation` extends `InstrumentationBase`, so it
  is compatible with `registerInstrumentations()` from
  `@opentelemetry/instrumentation`. A `register()` sugar is also exported,
  plus a `@ydbjs/telemetry/register` entry for
  `node --import @ydbjs/telemetry/register`.

  **Multi-driver attribution.** Every span and every metric data point
  carries `db.namespace`, `server.address`, and `server.port` from the
  publishing driver's `DriverIdentity` (stamped at publish-time by
  `@ydbjs/core`).

  **Time units.** Diagnostics-channel payloads stay in **milliseconds**
  (Node convention — `performance.now()`, `Date.now()`); spans and metrics
  are emitted in **seconds** (OTel canonical unit). The conversion lives
  in this package; attribute keys never carry an `_ms` suffix.

  **W3C trace context propagation.** Enabling the instrumentation installs
  a gRPC client middleware (via `@ydbjs/core`'s `addClientMiddleware`) that
  calls `propagation.inject(context.active(), metadata, …)` on every
  outgoing YDB RPC. Default propagator is `traceparent` / `tracestate`;
  set a different one globally via `propagation.setGlobalPropagator`.
  `register()` must be called **before** `new Driver(...)` for the
  middleware to apply — drivers compose the chain once at construction.

  **Spans.** Wraps every leaf YDB operation with a CLIENT span carrying
  `db.system.name=ydb`, `db.operation.name=<Service>.<Method>`, and
  operation-specific attributes. Nesting follows the natural call graph:

  ```
  ydb.Transaction
  └── ydb.RunWithRetry
      └── ydb.Try
          ├── ydb.AcquireSession              (opt-in, off by default)
          ├── ydb.CreateSession               (on miss)
          ├── ydb.ExecuteQuery
          ├── ydb.BeginTransaction / Commit / Rollback
          └── ydb.DeleteSession               (background, on session close)
  ```

  Plus `ydb.Discovery` (with connection-pool point-in-time events as
  span events) and `ydb.TokenFetch` (only on real fetches — cache hits
  don't open a span).

  **Metrics.** Synchronous instruments:
  - `db.client.operation.duration` (Histogram, `s`) — every leaf CLIENT
    operation attempt, tagged with `db.operation.name`. Standard OTel
    database semantic convention.
  - `ydb.driver.connection.pessimizations` (Counter)
  - `ydb.query.session.create.duration` (Histogram)
  - `ydb.query.session.acquire.duration` (Histogram)
  - `ydb.query.session.closed` (Counter, tagged with
    `ydb.session.close.reason` ∈ `{pool_close, attach_failed,
stream_closed, stream_error}`)
  - `ydb.query.session.acquire.failures` (Counter, tagged with
    `error.type`)
  - `ydb.auth.token.fetch.duration` (Histogram)
  - `ydb.auth.token.fetch.failures` (Counter)
  - `ydb.auth.token.refreshes` (Counter)
  - `ydb.auth.token.expirations` (Counter)
  - `ydb.retry.attempts` (Counter, tagged with `ydb.retry.outcome` ∈
    `{success, retried, non_retryable, exhausted}`)
  - `ydb.retry.duration` (Histogram, end-to-end loop including backoffs)

  Observable instruments fed by a per-`DriverIdentity` state registry:
  - `ydb.driver.connection.count` (`ObservableUpDownCounter`, tagged with
    `ydb.connection.state` ∈ `{live, pessimized}`)
  - `ydb.query.session.count` (`ObservableUpDownCounter`, tagged with
    `ydb.session.state` ∈ `{idle, acquired, creating}`)
  - `ydb.query.session.acquire.pending` (`ObservableUpDownCounter`)
  - `ydb.query.session.max` / `ydb.query.session.min` (`ObservableGauge`)

  All histograms ship with explicit bucket boundaries via OTel `advice`
  so the out-of-the-box distribution is usable without configuration —
  the SDK default (`[0, 5, 10, 25, …, 10000]`, ms-oriented) would collapse
  every `unit: 's'` recording into the first slot.

  **Configuration.** Two package-specific knobs; everything else is
  controlled at the OTel SDK level (Sampler / View / Resource / Exporter):
  - `captureQueryText` (default `false`) — include the raw YQL text as
    `db.query.text`. Off by default because query text may carry PII.
  - `emitAcquireSessionSpan` (default `false`) — emit `ydb.AcquireSession`
    spans. Off by default; warm-pool acquires are sub-ms and only add
    noise. Turn on to debug session-pool starvation.

  See `packages/telemetry/README.md` for the full attribute and metric
  catalogue, plus recipes for Sampler / View / Resource / OTLP exporter
  wiring.

  Acknowledgements: thanks to @hedgehogushka for the initial spike in
  [#601](https://github.com/ydb-platform/ydb-js-sdk/pull/601), which
  mapped out the problem space and informed the final design.
