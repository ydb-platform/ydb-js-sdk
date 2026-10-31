# @ydbjs/telemetry

## 7.0.0

### Major Changes

- [`a389fc4`](https://github.com/ydb-platform/ydb-js-sdk/commit/a389fc49a435b0a2686f0085b00f663d07f98096) Thanks [@polRk](https://github.com/polRk)! - Connect SDK services to `@ydbjs/grpc` and remove nice-grpc and grpc-js from the workspace. Service methods retain Promise results and AsyncIterable request/response streams, with AbortSignal cancellation and backpressure. Requires Node.js 22.15 or later supported by the SDK.

  Use `createServiceClient(service, transport)` for standalone calls. `Driver.createClient` retains discovery and node selection; `createPinnedClient` explicitly awaits endpoint pin acquisition. Configure TLS, message limits, and HTTP/2 windows through `transportOptions`. The transport does not replay RPCs or duplicate YDB balancing and retry policies.

  Call options accept plain metadata records, signals, absolute deadlines, and header/trailer/status observers. `RpcError` carries code, details, and trailing metadata; `MessageSizeError` identifies permanent local size-limit failures. Query metadata events expose the same record format. Register `addMetadataHook` before constructing Driver to add tracing headers. Credential providers supply `getToken`; Driver handles authentication and mandatory headers without middleware or interceptor adapters.

  High-level TopicWriter, TopicReader, query, and coordination operations retain their APIs. Generated API definitions remain independent of the transport at runtime. Request framing sends the header and serialized body separately, avoiding the payload copy used to prepend a gRPC frame header.

  Preserve explicit TLS server names when discovery provides no override, and avoid logging raw driver options.

  Preserve explicit gRPC endpoint ports when selecting TLS, including mixed-case URL schemes. Merge repeated case-insensitive call metadata values while keeping required driver headers authoritative over caller metadata and hooks.

- [#709](https://github.com/ydb-platform/ydb-js-sdk/pull/709) [`85601f5`](https://github.com/ydb-platform/ydb-js-sdk/commit/85601f5e42c9e7efcc9d44eb367e3bae12821b5c) Thanks [@polRk](https://github.com/polRk)! - Require OpenTelemetry API 1.10 and SDK 3.x (experimental packages 0.300.x). Update application providers, processors, and exporters together; SDK 2.x providers are not compatible with API 1.10. Trace context and baggage propagation remain supported.

### Patch Changes

- [`ea3692f`](https://github.com/ydb-platform/ydb-js-sdk/commit/ea3692fc850072a84a8d812826786642ccc1b1c1) Thanks [@polRk](https://github.com/polRk)! - Refresh compatible dependency versions and remove unused runtime packages. Include the `ms` types required by the Topic reader's published declarations.

- [#638](https://github.com/ydb-platform/ydb-js-sdk/pull/638) [`d5cdb51`](https://github.com/ydb-platform/ydb-js-sdk/commit/d5cdb515e7f5522d4008ec55d90dc00263f4df25) Thanks [@polRk](https://github.com/polRk)! - Drop the `pessimization.until` span-event attribute from the `ydb:driver.connection.pessimized` subscriber. The endpoints engine in `@ydbjs/core` no longer emits `until` (pessimization has no fixed timer), so the subscriber was writing `NaN` (`undefined / 1000`) as the attribute value under an active span. The `ATTR_YDB_DRIVER_CONNECTION_PESSIMIZATION_UNTIL` semconv constant is kept but deprecated.

  Add the `ydb.node.pile` (`ATTR_YDB_NODE_PILE`) span-event attribute to every `ydb:driver.connection.*` mapping, so bridge (2DC) traces show which pile each node belongs to alongside `ydb.node.dc`. The attribute is omitted on a non-bridge cluster (empty pile name).

- Updated dependencies [[`5d0cc28`](https://github.com/ydb-platform/ydb-js-sdk/commit/5d0cc2869176b222a6c12e6f3455a530178599be), [`cdff086`](https://github.com/ydb-platform/ydb-js-sdk/commit/cdff0864d850ba1bd1c7cf7c7041dd9742f04ef6), [`0edf569`](https://github.com/ydb-platform/ydb-js-sdk/commit/0edf569632df41da24e3a00d4ec5e141d914704a), [`64df3b5`](https://github.com/ydb-platform/ydb-js-sdk/commit/64df3b50005490e7c5a1628a6a9f31cb19e07d3d), [`807010c`](https://github.com/ydb-platform/ydb-js-sdk/commit/807010c6d784828b63676e351fd807ae0dd47338), [`65ba0fd`](https://github.com/ydb-platform/ydb-js-sdk/commit/65ba0fdf81aaaa880699633b005e1cf134f226a8), [`e6960f6`](https://github.com/ydb-platform/ydb-js-sdk/commit/e6960f6b4170c7d399739b364c45ed5ca8374eb4), [`549da21`](https://github.com/ydb-platform/ydb-js-sdk/commit/549da21a2f16312e5c774cb34ab4de87f40f3005), [`a389fc4`](https://github.com/ydb-platform/ydb-js-sdk/commit/a389fc49a435b0a2686f0085b00f663d07f98096), [`a4022e4`](https://github.com/ydb-platform/ydb-js-sdk/commit/a4022e4f218fa49d12796435f8722f7acd8b3d28), [`6ad8ff0`](https://github.com/ydb-platform/ydb-js-sdk/commit/6ad8ff016a40d9036add4d7db8dc5d0e6b8365de)]:
  - @ydbjs/api@7.0.0
  - @ydbjs/core@7.0.0
  - @ydbjs/error@6.1.0

## 6.0.1

### Patch Changes

- [#611](https://github.com/ydb-platform/ydb-js-sdk/pull/611) [`2986d90`](https://github.com/ydb-platform/ydb-js-sdk/commit/2986d90e501bcffada1612ed189753588c4de981) Thanks [@polRk](https://github.com/polRk)! - Tighten `@ydbjs/core` dependency to `^6.2.0` — the new `addClientMiddleware` API used to install the W3C trace context propagation middleware is only available there. Without this bump, installs that resolved `@ydbjs/core` to `6.1.x` would fail at runtime when `register()` tries to install the middleware.

  Refresh OpenTelemetry dependencies to current versions:
  - `@opentelemetry/api` `^1.9.0` → `^1.9.1`
  - `@opentelemetry/instrumentation` `^0.57.0` → `^0.218.0`
  - `@opentelemetry/semantic-conventions` `^1.32.0` → `^1.41.1`
  - dev deps (`@opentelemetry/core`, `@opentelemetry/context-async-hooks`, `@opentelemetry/sdk-metrics`, `@opentelemetry/sdk-trace-{base,node}`) aligned at `^2.7.1`

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
