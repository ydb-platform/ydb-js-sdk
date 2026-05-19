# @ydbjs/telemetry

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

## Spans

`db.operation.name` is service-prefixed (`Query.ExecuteQuery`,
`Discovery.ListEndpoints`, …) so traces stay unambiguous when the Table
service gets instrumented next to Query.

| Span name            | Channel                             | Kind     | Specific attributes                                                                                                                              |
| -------------------- | ----------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ydb.Discovery`      | `tracing:ydb:driver.discovery`      | CLIENT   | `db.operation.name="Discovery.ListEndpoints"` + (on `discovery.completed`) `ydb.discovery.{added,removed,total}_count`, `ydb.discovery.duration` |
| `ydb.Transaction`    | `tracing:ydb:query.transaction`     | CLIENT   | `ydb.isolation`, `ydb.idempotent`                                                                                                                |
| `ydb.Begin`          | `tracing:ydb:query.begin`           | CLIENT   | `db.operation.name="Query.BeginTransaction"`, `ydb.session.id`, `ydb.node.id`, `ydb.isolation`                                                   |
| `ydb.ExecuteQuery`   | `tracing:ydb:query.execute`         | CLIENT   | `db.operation.name="Query.ExecuteQuery"`, `db.query.text`? (opt-in), `ydb.session.id`, `ydb.node.id`, `ydb.idempotent`, `ydb.isolation`          |
| `ydb.Commit`         | `tracing:ydb:query.commit`          | CLIENT   | `db.operation.name="Query.CommitTransaction"`, `ydb.session.id`, `ydb.node.id`, `ydb.transaction.id`                                             |
| `ydb.Rollback`       | `tracing:ydb:query.rollback`        | CLIENT   | `db.operation.name="Query.RollbackTransaction"`, `ydb.session.id`, `ydb.node.id`, `ydb.transaction.id`                                           |
| `ydb.CreateSession`  | `tracing:ydb:query.session.create`  | CLIENT   | `db.operation.name="Query.CreateSession"`                                                                                                        |
| `ydb.DeleteSession`  | `tracing:ydb:query.session.delete`  | CLIENT   | `db.operation.name="Query.DeleteSession"`, `ydb.session.id`, `ydb.node.id`, `ydb.session.close.reason`, `ydb.session.uptime`                     |
| `ydb.AcquireSession` | `tracing:ydb:query.session.acquire` | INTERNAL | _(opt-in via `emitAcquireSessionSpan`)_                                                                                                          |
| `ydb.RunWithRetry`   | `tracing:ydb:retry.run`             | INTERNAL | `ydb.idempotent` + (on `retry.exhausted`) `ydb.retry.attempts_total`, `ydb.retry.total_duration`                                                 |
| `ydb.Try`            | `tracing:ydb:retry.attempt`         | INTERNAL | `ydb.retry.attempt`, `ydb.idempotent`, `ydb.retry.backoff` (seconds; `0` for attempt 1)                                                          |
| `ydb.TokenFetch`     | `tracing:ydb:auth.token.fetch`      | INTERNAL | `ydb.auth.provider`                                                                                                                              |

Identity attributes (`db.system.name="ydb"`, `db.namespace`, `server.address`,
`server.port`) flow through the channel payload — producers stamp them at
publish-time, so no AsyncLocalStorage wrapping is required on the producer
side. On error, every span additionally carries `db.response.status_code`
(when the server returned a YDB status) and `error.type` ∈
{`ydb_error`, `transport_error`, `<Error.name>`, `unknown`}.

### Span events (point-in-time)

When a connection-pool event fires while a tracing channel span is active
(typically a `ydb.Discovery` span during a discovery round), it is recorded
as a `span.addEvent`. When no span is active, the event is dropped by the
traces pipeline — the metrics pipeline picks it up regardless.

| Event name                           | Channel                              | Attributes                                                     |
| ------------------------------------ | ------------------------------------ | -------------------------------------------------------------- |
| `ydb.driver.connection.added`        | `ydb:driver.connection.added`        | `ydb.node.id`, `ydb.node.dc`, `network.peer.address`           |
| `ydb.driver.connection.pessimized`   | `ydb:driver.connection.pessimized`   | `… + ydb.driver.connection.pessimization.until` (unix seconds) |
| `ydb.driver.connection.unpessimized` | `ydb:driver.connection.unpessimized` | `… + ydb.driver.connection.pessimization.duration` (seconds)   |
| `ydb.driver.connection.retired`      | `ydb:driver.connection.retired`      | `… + ydb.driver.connection.retire.reason`                      |
| `ydb.driver.connection.removed`      | `ydb:driver.connection.removed`      | `… + ydb.driver.connection.remove.reason`                      |

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
| `ydb.auth.token.expirations`           | Counter   | `{expiration}` | `ydb.auth.provider`                                                                  | `ydb:auth.token.expired`                                                                                                                                                                                                                                                                                                    |
| `ydb.retry.attempts`                   | Counter   | `{attempt}`    | `ydb.idempotent`, `ydb.retry.outcome` ∈ {success, retried, exhausted, non_retryable} | `ydb:retry.attempt.completed`                                                                                                                                                                                                                                                                                               |
| `ydb.retry.duration`                   | Histogram | `s`            | `ydb.idempotent`, `ydb.retry.outcome`                                                | `tracing:ydb:retry.run.asyncEnd` / `.error` (end-to-end, including backoffs)                                                                                                                                                                                                                                                |

### Observable instruments

State for these is reconstructed from lifecycle events in two per-driver
registries (`ConnectionPoolRegistry` for the gRPC connection pool,
`SessionPoolRegistry` for the query session pool). Late-attaching subscribers
(those registered after a driver is already `ready`) miss the initial state —
that's an explicit trade-off vs. introducing a "snapshot" channel. Register
telemetry at process start (the standard pattern) to avoid the gap.

| Instrument                          | Kind                    | Unit           | Tags                                                   | State updated by                                                                                              |
| ----------------------------------- | ----------------------- | -------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `ydb.driver.connection.count`       | ObservableUpDownCounter | `{connection}` | `ydb.connection.state` ∈ {`live`, `pessimized`}        | `ydb:driver.connection.{added,pessimized,unpessimized,retired,removed}`; entry deleted on `ydb:driver.closed` |
| `ydb.query.session.count`           | ObservableUpDownCounter | `{session}`    | `ydb.session.state` ∈ {`idle`, `acquired`, `creating`} | `ydb:query.session.{created,closed,acquired,released}` + hooks on `tracing:ydb:query.session.create`          |
| `ydb.query.session.acquire.pending` | ObservableUpDownCounter | `{request}`    | _(identity only)_                                      | `ydb:query.session.waiter.{enqueued,dequeued}`                                                                |
| `ydb.query.session.max`             | ObservableGauge         | `{session}`    | _(identity only)_                                      | `ydb:query.session.pool.opened` snapshot                                                                      |
| `ydb.query.session.min`             | ObservableGauge         | `{session}`    | _(identity only)_                                      | `ydb:query.session.pool.opened` snapshot                                                                      |

### Cardinality budget

All tag values are bounded and safe to ingest at high request rates:

- `db.operation.name` — 10 fixed strings (Query.\*, Discovery.ListEndpoints, Auth.TokenFetch)
- `ydb.session.close.reason` — 4 strings (`pool_close`, `attach_failed`, `stream_closed`, `stream_error`)
- `ydb.retry.outcome` — 4 strings
- `ydb.connection.state` — 2 strings
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

## Non-goals (this version)

- Structured logs are out of scope. Producers already emit driver / auth /
  session lifecycle events on dc; a separate logs subscriber will land later.
- Cross-process trace context propagation. The instrumentation operates
  inside the SDK boundary; trace context for outgoing gRPC calls is handled
  by the user's OTel SDK setup.
- See the "Deferred" subsection of [Metrics](#metrics) for instruments that
  need new producer events.
