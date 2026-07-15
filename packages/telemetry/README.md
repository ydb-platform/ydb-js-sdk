# @ydbjs/telemetry

[![codecov](https://codecov.io/gh/ydb-platform/ydb-js-sdk/graph/badge.svg?component=telemetry)](https://ydb-appteam-sdk-reports.website.yandexcloud.net/ydb-js-sdk/coverage/packages/telemetry/)

OpenTelemetry instrumentation for the YDB JavaScript SDK. Subscribes to
`node:diagnostics_channel` events emitted by `@ydbjs/core`, `@ydbjs/query`,
`@ydbjs/auth`, and `@ydbjs/retry`, and converts them into OTel **spans** and
**metrics**.

## Features

- Zero-cost when no subscriber is attached — producers use
  `tracingChannel.tracePromise` which short-circuits if no one listens.
- No monkey-patching. All instrumentation flows through
  `node:diagnostics_channel`.
- Multi-driver attribution out of the box — every span and every metric data
  point carries `db.namespace`, `server.address`, and `server.port` from the
  publishing driver's identity (`@ydbjs/core` stamps it at publish-time).
- Time unit conversion handled here: dc payloads stay in **milliseconds**
  (Node.js convention); spans and metrics are emitted in **seconds** (OTel
  canonical unit). Attribute keys never carry an `_ms` suffix.
- Standard `enable()` / `disable()` lifecycle via `InstrumentationBase`.
  Compatible with `registerInstrumentations()` from
  `@opentelemetry/instrumentation`.
- W3C trace context propagation — `register()` installs a gRPC client
  middleware that carries `traceparent` / `tracestate` (and any other
  propagator registered via `propagation.setGlobalPropagator`) into
  outgoing YDB calls. See [Propagation to YDB](#propagation-to-ydb) below.

## Installation

```sh
npm install @ydbjs/telemetry
```

## Usage

### Programmatic

```ts
import { NodeSDK } from '@opentelemetry/sdk-node'
import { register } from '@ydbjs/telemetry'

let sdk = new NodeSDK({
  /* exporter, resource, ... */
})
sdk.start()

let instrumentation = register({
  captureQueryText: false,
  emitAcquireSessionSpan: false,
})

// Later, on shutdown:
instrumentation.disable()
await sdk.shutdown()
```

### Auto-registration

```sh
node --import @opentelemetry/sdk-node/register \
     --import @ydbjs/telemetry/register \
     your-app.js
```

The OTel SDK must be initialised before `@ydbjs/telemetry/register` runs, so
the global tracer provider is already in place when subscribers attach.

## Configuration

| Option                   | Default | Description                                                                                                                                               |
| ------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `captureQueryText`       | `false` | Include the raw YQL text as `db.query.text`. Disabled by default — query text may contain PII.                                                            |
| `emitAcquireSessionSpan` | `false` | Emit `ydb.AcquireSession` spans. Off by default — session acquisition is almost always instant (warm pool hit). Turn on to debug session-pool starvation. |

To drop other spans (e.g. `ydb.Try`, `ydb.Transaction`) or skip orphan
root traces, configure your OpenTelemetry SDK's sampler — it applies
uniformly across every instrumentation, not just this one.

## Customising emitted telemetry

`@ydbjs/telemetry` is an `InstrumentationBase` subclass, so it integrates
with the standard OTel pipeline. The two options above are the only knobs
specific to this package; everything else is configured at the SDK level
and applies uniformly across all instrumentations.

| Knob                                                           | Controlled by                         | Example use case                                |
| -------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------- |
| Span sampling rate / drop specific spans                       | OTel `Sampler`                        | Sample 1% of traces, or drop `ydb.Try`          |
| Histogram bucket layout, metric tag pruning, rename            | OTel `View`                           | Switch `ydb.retry.duration` to explicit buckets |
| `service.name`, `deployment.environment`, custom resource tags | OTel `Resource`                       | Attribute traces to the right service           |
| Choose / configure exporter                                    | OTel `SpanProcessor` + `MetricReader` | OTLP, Jaeger, Prometheus, console               |
| Periodic export interval                                       | `PeriodicExportingMetricReader`       | Trade freshness vs. ingestion cost              |
| Disable instrumentation at runtime                             | `instrumentation.disable()`           | Pause telemetry in tests                        |

### Drop noisy spans with a sampler

`ydb.Try` and `ydb.Transaction` are wrapper spans — useful for retry
debugging but noise on a high-RPS service. A small custom sampler
combined with `ParentBasedSampler` keeps the rest of the tree intact:

```ts
import {
  ParentBasedSampler,
  type Sampler,
  SamplingDecision,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base'

let DROPPED = new Set(['ydb.Try', 'ydb.Transaction'])

let dropWrappers: Sampler = {
  shouldSample(_ctx, _traceId, name) {
    return DROPPED.has(name)
      ? { decision: SamplingDecision.NOT_RECORD }
      : { decision: SamplingDecision.RECORD_AND_SAMPLED }
  },
  toString: () => 'DropWrapperSpans',
}

new NodeSDK({
  sampler: new ParentBasedSampler({ root: dropWrappers }),
  // ...
})
```

### Customise histogram buckets via View

```ts
import { ExplicitBucketHistogramAggregation, View } from '@opentelemetry/sdk-metrics'

new NodeSDK({
  views: [
    new View({
      instrumentName: 'ydb.retry.duration',
      aggregation: new ExplicitBucketHistogramAggregation([0.01, 0.05, 0.1, 0.5, 1, 5, 30]),
    }),
    // Drop the `ydb.idempotent` tag from retry counters if you don't need it
    new View({ instrumentName: 'ydb.retry.attempts', attributeKeys: ['ydb.retry.outcome'] }),
  ],
})
```

### Identify the service in exported telemetry

```ts
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions/incubating'

new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: 'orders-api',
    [ATTR_SERVICE_VERSION]: process.env.GIT_SHA,
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: 'production',
  }),
})
```

Identity attributes the SDK emits per request (`db.namespace`,
`server.address`, `server.port`) come from the YDB driver and are
orthogonal to resource attributes.

### Wire an OTLP exporter (traces + metrics)

```ts
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'

new NodeSDK({
  traceExporter: new OTLPTraceExporter({ url: 'http://collector:4318/v1/traces' }),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: 'http://collector:4318/v1/metrics' }),
    exportIntervalMillis: 10_000,
  }),
})
```

### Graceful shutdown

```ts
let instrumentation = register({ captureQueryText: false, emitAcquireSessionSpan: false })

async function shutdown() {
  instrumentation.disable() // 1. stop publishing into the OTel SDK
  await sdk.shutdown() // 2. flush exporters
}
process.on('SIGTERM', shutdown)
```

### What you cannot configure here

The following are part of the package's semconv contract — change them via
a PR, not configuration:

- Which `node:diagnostics_channel` topics the pipeline subscribes to.
- Span names (`ydb.ExecuteQuery`, `ydb.Try`, …) and the `db.operation.name` mapping.
- Metric instrument names (`db.client.operation.duration`, `ydb.retry.attempts`, …).
- Attribute key names (`ydb.session.id`, `ydb.retry.outcome`, …).
- Synchronous-handler error policy: thrown exceptions inside our subscribers are swallowed and logged via OTel's `DiagLogger`, never re-thrown into the SDK call site.

If you want a custom subscriber alongside ours — e.g. a structured-log sink —
subscribe to `node:diagnostics_channel` directly. The producer's channel
surface is documented in each package's README (`@ydbjs/core`,
`@ydbjs/query`, `@ydbjs/retry`, `@ydbjs/auth`).

## Spans

`db.operation.name` is service-prefixed (`Query.ExecuteQuery`,
`Discovery.ListEndpoints`, …) so traces stay unambiguous when the Table
service gets instrumented next to Query.

| Span name            | Channel                             | Kind     | Specific attributes                                                                                                                                                                                                                   |
| -------------------- | ----------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ydb.Discovery`      | `tracing:ydb:driver.discovery`      | CLIENT   | `db.operation.name="Discovery.ListEndpoints"` + (on `discovery.completed`) `ydb.discovery.{added,removed,total}_count`, `ydb.discovery.duration`, and on a bridge cluster `ydb.discovery.self_location`, `ydb.discovery.primary_pile` |
| `ydb.Transaction`    | `tracing:ydb:query.transaction`     | CLIENT   | `ydb.isolation`, `ydb.idempotent`                                                                                                                                                                                                     |
| `ydb.Begin`          | `tracing:ydb:query.begin`           | CLIENT   | `db.operation.name="Query.BeginTransaction"`, `ydb.session.id`, `ydb.node.id`, `ydb.isolation`                                                                                                                                        |
| `ydb.ExecuteQuery`   | `tracing:ydb:query.execute`         | CLIENT   | `db.operation.name="Query.ExecuteQuery"`, `db.query.text`? (opt-in), `ydb.session.id`, `ydb.node.id`, `ydb.idempotent`, `ydb.isolation`                                                                                               |
| `ydb.Commit`         | `tracing:ydb:query.commit`          | CLIENT   | `db.operation.name="Query.CommitTransaction"`, `ydb.session.id`, `ydb.node.id`, `ydb.transaction.id`                                                                                                                                  |
| `ydb.Rollback`       | `tracing:ydb:query.rollback`        | CLIENT   | `db.operation.name="Query.RollbackTransaction"`, `ydb.session.id`, `ydb.node.id`, `ydb.transaction.id`                                                                                                                                |
| `ydb.CreateSession`  | `tracing:ydb:query.session.create`  | CLIENT   | `db.operation.name="Query.CreateSession"`                                                                                                                                                                                             |
| `ydb.DeleteSession`  | `tracing:ydb:query.session.delete`  | CLIENT   | `db.operation.name="Query.DeleteSession"`, `ydb.session.id`, `ydb.node.id`, `ydb.session.close.reason`, `ydb.session.uptime`                                                                                                          |
| `ydb.AcquireSession` | `tracing:ydb:query.session.acquire` | INTERNAL | _(opt-in via `emitAcquireSessionSpan`)_                                                                                                                                                                                               |
| `ydb.RunWithRetry`   | `tracing:ydb:retry.run`             | INTERNAL | `ydb.idempotent` + (on `retry.exhausted`) `ydb.retry.attempts_total`, `ydb.retry.total_duration`                                                                                                                                      |
| `ydb.Try`            | `tracing:ydb:retry.attempt`         | INTERNAL | `ydb.retry.attempt`, `ydb.idempotent`, `ydb.retry.backoff` (seconds; `0` for attempt 1)                                                                                                                                               |
| `ydb.TokenFetch`     | `tracing:ydb:auth.token.fetch`      | INTERNAL | `ydb.auth.provider`                                                                                                                                                                                                                   |

Identity attributes (`db.system.name="ydb"`, `db.namespace`, `server.address`,
`server.port`) flow through the channel payload — producers stamp them at
publish-time, so no AsyncLocalStorage wrapping is required on the producer
side. On error, every span additionally carries `db.response.status_code`
(when the server returned a YDB status) and `error.type` ∈
{`ydb_error`, `transport_error`, `<Error.name>`, `unknown`}.

`ydb.TokenFetch` is only emitted when a credential provider actually goes to
the network for a token — every provider (`static`, `metadata`,
`yc-service-account`) short-circuits cache hits **before** wrapping the
fetch in `tracingChannel.tracePromise`, so a warm cache never produces a
span. Opportunistic background refreshes do produce one (they perform real
IO), as a root span if no caller-side trace is active.

### Span events (point-in-time)

When a connection-pool event fires while a tracing channel span is active
(typically a `ydb.Discovery` span during a discovery round), it is recorded
as a `span.addEvent`. When no span is active, the event is dropped by the
traces pipeline — the metrics pipeline picks it up regardless.

The connection events additionally carry `ydb.node.pile` on a bridge (2DC)
cluster (omitted when the pile name is empty).

| Event name                           | Channel                              | Attributes                                                                                                           |
| ------------------------------------ | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `ydb.driver.connection.added`        | `ydb:driver.connection.added`        | `ydb.node.id`, `ydb.node.dc`, `ydb.node.pile`?, `network.peer.address`                                               |
| `ydb.driver.connection.pessimized`   | `ydb:driver.connection.pessimized`   | `ydb.node.id`, `ydb.node.dc`, `ydb.node.pile`?, `network.peer.address`                                               |
| `ydb.driver.connection.unpessimized` | `ydb:driver.connection.unpessimized` | `… + ydb.driver.connection.pessimization.duration` (seconds)                                                         |
| `ydb.driver.connection.retired`      | `ydb:driver.connection.retired`      | `… + ydb.driver.connection.retire.reason`                                                                            |
| `ydb.driver.connection.removed`      | `ydb:driver.connection.removed`      | `… + ydb.driver.connection.remove.reason`                                                                            |
| `ydb.driver.pile.changed`            | `ydb:driver.pile.changed`            | `ydb.driver.pile.primary_before`?, `ydb.driver.pile.primary_after`? (bridge only; the structured roster stays on dc) |

## Metrics

The pipeline registers OTel instruments via the package's own `Meter`. All
data points carry the identity attributes above (when the source ctx /
payload includes a driver — most channels do).

### Synchronous instruments

| Instrument                             | Kind      | Unit           | Tags (beyond identity)                                                               | Source                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------- | --------- | -------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db.client.operation.duration`         | Histogram | `s`            | `db.operation.name`, `error.type`?                                                   | every leaf CLIENT tracing channel: `query.{execute,begin,commit,rollback,session.create,session.delete}` and `driver.discovery`. Auth token fetch is its own INTERNAL span recorded by `ydb.auth.token.fetch.duration` below — not a database operation. Uses the OTel-standard metric so off-the-shelf db dashboards work. |
| `ydb.driver.connection.pessimizations` | Counter   | `{event}`      | _(none)_                                                                             | `ydb:driver.connection.pessimized`                                                                                                                                                                                                                                                                                          |
| `ydb.query.session.create.duration`    | Histogram | `s`            | _(none)_                                                                             | `tracing:ydb:query.session.create.asyncEnd`                                                                                                                                                                                                                                                                                 |
| `ydb.query.session.acquire.duration`   | Histogram | `s`            | _(none)_                                                                             | `tracing:ydb:query.session.acquire.asyncEnd`                                                                                                                                                                                                                                                                                |
| `ydb.query.session.closed`             | Counter   | `{session}`    | `ydb.session.close.reason`                                                           | `ydb:query.session.closed`                                                                                                                                                                                                                                                                                                  |
| `ydb.query.session.acquire.failures`   | Counter   | `{failure}`    | `error.type`                                                                         | `ydb:query.session.acquire.failed` (caller-aborted acquires are not published, so they do not count as failures)                                                                                                                                                                                                            |
| `ydb.auth.token.fetch.duration`        | Histogram | `s`            | `ydb.auth.provider`, `error.type`?                                                   | `tracing:ydb:auth.token.fetch.asyncEnd` / `.error`                                                                                                                                                                                                                                                                          |
| `ydb.auth.token.fetch.failures`        | Counter   | `{failure}`    | `ydb.auth.provider`, `error.type`                                                    | `ydb:auth.provider.failed`                                                                                                                                                                                                                                                                                                  |
| `ydb.auth.token.refreshes`             | Counter   | `{refresh}`    | `ydb.auth.provider`                                                                  | `ydb:auth.token.refreshed` — successful refreshes only; direct rate signal complementing the `fetch.duration` histogram                                                                                                                                                                                                     |
| `ydb.auth.token.expirations`           | Counter   | `{expiration}` | `ydb.auth.provider`                                                                  | `ydb:auth.token.expired`                                                                                                                                                                                                                                                                                                    |
| `ydb.retry.attempts`                   | Counter   | `{attempt}`    | `ydb.idempotent`, `ydb.retry.outcome` ∈ {success, retried, exhausted, non_retryable} | `ydb:retry.attempt.completed`                                                                                                                                                                                                                                                                                               |
| `ydb.retry.duration`                   | Histogram | `s`            | `ydb.idempotent`, `ydb.retry.outcome`                                                | `tracing:ydb:retry.run.asyncEnd` / `.error` (end-to-end, including backoffs)                                                                                                                                                                                                                                                |
| `ydb.driver.pile.fallbacks`            | Counter   | `{event}`      | `ydb.pile.fallback.active` (bool — true entered fallback, false recovered)           | `ydb:driver.pile.fallback` (bridge only; edge-triggered when `preferPrimaryPile` starts/stops serving from the SYNCHRONIZED fallback tier)                                                                                                                                                                                  |
| `ydb.driver.pile.changes`              | Counter   | `{event}`      | _(identity only)_                                                                    | `ydb:driver.pile.changed` (bridge only; the pile roster/statuses changed)                                                                                                                                                                                                                                                   |

### Observable instruments

State for these is reconstructed from lifecycle events in two per-driver
registries (`ConnectionPoolRegistry` for the gRPC connection pool,
`SessionPoolRegistry` for the query session pool). The `ydb.driver.pool.*`
gauges are the exception: they mirror the whole-snapshot `pool.stats` payload
directly (not reassembled from deltas), so a late subscriber recovers the
routing view on the next routable-set change rather than staying blind. The
per-connection / per-session gauges still miss the initial state of an
already-`ready` driver — an explicit trade-off vs. a per-entity snapshot
channel. Register telemetry at process start (the standard pattern) to avoid
the gap.

| Instrument                          | Kind                    | Unit           | Tags                                                                                                             | State updated by                                                                                                                    |
| ----------------------------------- | ----------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `ydb.driver.connection.count`       | ObservableUpDownCounter | `{connection}` | `ydb.connection.state` ∈ {`live`, `pessimized`}                                                                  | `ydb:driver.connection.{added,pessimized,unpessimized,retired,removed}`; entry deleted on `ydb:driver.closed`                       |
| `ydb.query.session.count`           | ObservableUpDownCounter | `{session}`    | `ydb.session.state` ∈ {`idle`, `acquired`, `creating`}                                                           | `ydb:query.session.{created,closed,acquired,released}` + hooks on `tracing:ydb:query.session.create`                                |
| `ydb.query.session.acquire.pending` | ObservableUpDownCounter | `{request}`    | _(identity only)_                                                                                                | `ydb:query.session.waiter.{enqueued,dequeued}`                                                                                      |
| `ydb.query.session.max`             | ObservableGauge         | `{session}`    | _(identity only)_                                                                                                | `ydb:query.session.pool.opened` snapshot                                                                                            |
| `ydb.query.session.min`             | ObservableGauge         | `{session}`    | _(identity only)_                                                                                                | `ydb:query.session.pool.opened` snapshot                                                                                            |
| `ydb.driver.pool.routable`          | ObservableGauge         | `{connection}` | `ydb.routing.tier` ∈ {`prefer`, `fallback`}, `ydb.routing.prefer_primary_pile`?, `ydb.routing.locality_enabled`? | `ydb:driver.connection.pool.stats` snapshot; routing mode folded in from `ydb:driver.connection.pool.opened`                        |
| `ydb.driver.pool.pessimized`        | ObservableGauge         | `{connection}` | _(identity only)_                                                                                                | `ydb:driver.connection.pool.stats` snapshot (pool-authoritative; complements the event-reconstructed `ydb.driver.connection.count`) |
| `ydb.driver.pool.nodes`             | ObservableGauge         | `{node}`       | `ydb.pile.name`, `ydb.pile.status`                                                                               | `ydb:driver.connection.pool.stats` snapshot (bridge only; empty piles off-bridge)                                                   |

### Histogram bucket defaults

Every histogram is registered with `advice.explicitBucketBoundaries` so the
out-of-the-box distribution is usable without configuration. The OTel SDK
default (designed for milliseconds: `[0, 5, 10, 25, …, 10000]`) buckets all
sub-second YDB ops into the first slot, which is why we override.

| Histogram                            | Boundaries (seconds)                                                                                               | Why                                                                                                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db.client.operation.duration`       | `0.0005, 0.001, 0.0025, 0.005, 0.0075, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10, 30, 60` | Dense middle (1ms–1s) covers warm-cache reads + typical Execute; tail extends to overload-backoff territory.                                                                                                               |
| `ydb.query.session.create.duration`  | `0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10`                                                          | CreateSession + first AttachStream message — typically tens of ms, capped well below operation timeouts.                                                                                                                   |
| `ydb.query.session.acquire.duration` | `0.0001, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30`                                                    | Warm-pool acquires are sub-millisecond. When the pool has capacity but no idle session, an acquire wraps a full `session.create`, so the upper tail must cover create's tail (10s) plus a 30s slot for genuine starvation. |
| `ydb.auth.token.fetch.duration`      | `0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30`                                                                    | IAM/JWT round-trip; 30s tail matches typical request timeouts.                                                                                                                                                             |
| `ydb.retry.duration`                 | `0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60, 300`                                                                      | End-to-end loop including backoffs — overload-induced retry sequences can stretch to minutes.                                                                                                                              |

Override per-histogram in your OTel SDK config with a `View`:

```ts
new View({
  instrumentName: 'db.client.operation.duration',
  aggregation: new ExplicitBucketHistogramAggregation([
    /* your boundaries */
  ]),
})
```

### Cardinality budget

All tag values are bounded and safe to ingest at high request rates:

- `db.operation.name` — 10 fixed strings (Query.\*, Discovery.ListEndpoints, Auth.TokenFetch)
- `ydb.session.close.reason` — 4 strings (`pool_close`, `attach_failed`, `stream_closed`, `stream_error`)
- `ydb.retry.outcome` — 4 strings
- `ydb.connection.state` — 2 strings
- `ydb.routing.tier` — 2 strings (`prefer`, `fallback`); `ydb.routing.prefer_primary_pile` / `ydb.routing.locality_enabled` / `ydb.pile.fallback.active` — booleans
- `ydb.pile.name` / `ydb.pile.status` — bounded by the cluster's bridge topology (a handful of piles, 7 statuses)
- `ydb.auth.provider` — bounded by the credential providers configured in the process
- identity tags (`db.namespace`, `server.address`, `server.port`) — bounded by the deployment

Tags **never** set on metrics (always unbounded, OK for spans only):
`ydb.session.id`, `ydb.transaction.id`, `db.query.text`.

### Deferred (planned)

Awaiting new producer-side events / channels — these instruments are NOT
emitted in this version:

- `ydb.driver.connection.count` state breakdown into `{idle, busy}` — needs new events for "connection routed to RPC" / "returned to pool"

## How it works

The SDK publishes structured events to `node:diagnostics_channel` topics
named `tracing:ydb:*` (operations with a duration) and `ydb:*` (point-in-time
or summary events).

For each `tracing:ydb:*` channel, `@ydbjs/telemetry` subscribes a bundle of
handlers (`start`, `asyncEnd`, `error`) that create, finalise, or fail an OTel
span keyed by the channel's `ctx` object (held in a `WeakMap` so leaks are
bounded by GC).

Parent-child relationships between nested spans (e.g.
`ydb.Transaction → ydb.ExecuteQuery`) propagate through a private
`AsyncLocalStorage` bound to each scope channel via
`tracingChannel.start.bindStore`. Node manages the ALS frame around the
channel body, so `disable()` cleanly tears down the binding without orphaning
state.

## Propagation to YDB

`register()` installs a gRPC client middleware into `@ydbjs/core` (via
`addClientMiddleware` — a small public hook exported from `@ydbjs/core`).
On every outgoing RPC it calls
`propagation.inject(context.active(), metadata, …)`, serialising the active
OTel context into gRPC metadata using whichever propagator is globally
registered. With no SDK registered the global propagator is a no-op.

**Order of operations matters.** Drivers compose the middleware chain
**once** at construction time, so `register()` must run **before**
`new Driver(...)`. Matches OTel's `NodeSDK.start()` pattern.

```ts
sdk.start()                 // 1. OTel SDK
register({ /* … */ })       // 2. @ydbjs/telemetry
let driver = new Driver(…)  // 3. YDB driver — picks up the middleware
```

Default propagator is W3C `traceparent` / `tracestate`. Override with any
other format by setting it before `register()`:

```ts
import { propagation } from '@opentelemetry/api'
import { W3CTraceContextPropagator } from '@opentelemetry/core'

// NodeSDK registers the W3C propagator by default; only set this manually
// if you want a different format (e.g. B3, AWS X-Amzn).
propagation.setGlobalPropagator(new W3CTraceContextPropagator())
```

**For propagation to actually carry your trace id, the YDB call must run
inside an active OTel context.** The typical pattern: wrap the call in your
own span.

```ts
import { trace } from '@opentelemetry/api'

let tracer = trace.getTracer('my-app')

await tracer.startActiveSpan('checkout', async (span) => {
  try {
    let rows = await sql`SELECT * FROM orders WHERE id = ${orderId}`
    // Inside `startActiveSpan` callback, `context.active()` carries the new
    // span — the propagator middleware emits a matching `traceparent`.
  } finally {
    span.end()
  }
})
```

> **Note.** `@ydbjs/telemetry`'s own internal spans (`ydb.Query.ExecuteQuery`,
> `ydb.AcquireSession`, …) are created via the global `TracerProvider` but
> are **not** activated in OTel's `ContextManager` — they live in a private
> `AsyncLocalStorage` used only for parent-child linkage between sibling
> SDK spans. So a `SELECT` issued **without** a user-created outer span will
> still produce a `ydb.Query.ExecuteQuery` span locally, but the
> `traceparent` sent to YDB will carry no trace id. Wrap YDB calls in your
> own span (or in any other OTel-instrumented work) to get end-to-end
> propagation.

## Non-goals (this version)

- Structured logs are out of scope. Producers already emit driver / auth /
  session lifecycle events on dc; a separate logs subscriber will land later.
- See the "Deferred" subsection of [Metrics](#metrics) for instruments that
  need new producer events.
