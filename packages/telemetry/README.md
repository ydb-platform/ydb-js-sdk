# @ydbjs/telemetry

OpenTelemetry instrumentation for the YDB JavaScript SDK. Subscribes to `node:diagnostics_channel` events published by `@ydbjs/core`, `@ydbjs/query`, `@ydbjs/auth`, and `@ydbjs/retry`, and converts them into OpenTelemetry traces, metrics, and logs — without any coupling between the SDK and a specific telemetry vendor.

## Features

- Traces for driver init, discovery, auth, session pool, transactions, queries, and retries
- Metrics for operation durations, session pool state, and retry statistics
- Optional structured logs via the OpenTelemetry Logs API (`logs: true`)
- Context propagation via `AsyncLocalStorage` — nested spans link automatically
- Zero-code setup via `node --import @ydbjs/telemetry/register`
- Fully tree-shakeable: enable or disable traces, metrics, and logs independently
- TypeScript support

## Installation

```sh
npm install @ydbjs/telemetry
```

You also need an OpenTelemetry SDK and an exporter. Example with OTLP/HTTP:

```sh
npm install @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http
```

## Usage

### Programmatic setup

Call `register()` **after** the OTel SDK is started. The returned `TelemetryResult` is a `Disposer` that also carries `hooks` for the `Driver`.

```ts
import { NodeSDK } from '@opentelemetry/sdk-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { register } from '@ydbjs/telemetry'
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'

// 1. Start OpenTelemetry before any instrumented code.
//    Sends spans to http://localhost:4318/v1/traces by default.
const sdk = new NodeSDK({
  serviceName: 'my-ydb-app',
  traceExporter: new OTLPTraceExporter(),
})
sdk.start()

// 2. Register telemetry — subscribes to all SDK diagnostics_channel events.
const telemetry = register({
  endpoint: 'grpc://localhost:2136/local',
})

// 3. Pass telemetry.hooks to the Driver for per-RPC span enrichment.
const driver = new Driver('grpc://localhost:2136/local', {
  hooks: telemetry.hooks,
})
await driver.ready()

const sql = query(driver)
const [[row]] = await sql`SELECT 1 AS n`
console.log(row)

// 4. Flush spans, then unsubscribe.
await sdk.shutdown()
telemetry()
driver.close()
```

### Zero-code setup via `node --import`

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
OTEL_SERVICE_NAME=my-ydb-app \
node \
  --import @opentelemetry/sdk-node/register \
  --import @ydbjs/telemetry/register \
  your-app.js
```

`@ydbjs/telemetry/register` calls `register()` with default options. The OTel SDK **must** be initialised first so that the global tracer provider is ready when `register()` runs. Configure the exporter via standard `OTEL_*` environment variables.

### Disposing

`register()` returns a `Disposer` — a function that unsubscribes all channel listeners. It also implements `Symbol.dispose` and `Symbol.asyncDispose` for explicit resource management:

```ts
// Call as a function:
telemetry()

// Or with using (TypeScript 5.2+ / Node 20+):
{
  using telemetry = register({ endpoint: 'grpc://localhost:2136/local' })
  // ...
} // automatically unsubscribes on scope exit
```

## Configuration

`register(options?)` accepts:

| Option             | Type      | Default | Description                                                                                            |
| ------------------ | --------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `contextManager`   | `boolean` | `true`  | Install an `AsyncLocalStorage`-based OTel context manager for automatic span propagation               |
| `traces`           | `boolean` | `true`  | Subscribe to tracing channels and create spans                                                         |
| `metrics`          | `boolean` | `true`  | Record metrics (durations, session pool gauges, retry counters)                                        |
| `logs`             | `boolean` | `false` | Emit structured logs via the OTel Logs API                                                             |
| `endpoint`         | `string`  | —       | YDB connection string — used to populate `server.address`, `server.port`, `db.namespace` on every span |
| `captureQueryText` | `boolean` | `false` | Set `db.query.text` to the actual YQL text. Disabled by default — query text may contain PII           |
| `tracer`           | `Tracer`  | —       | Custom tracer instance. Defaults to the global OTel tracer                                             |

## Spans

### Base attributes

Every span receives these attributes (populated from `endpoint` when provided):

| Attribute        | Description                       |
| ---------------- | --------------------------------- |
| `db.system.name` | Always `ydb`                      |
| `server.address` | Hostname parsed from the endpoint |
| `server.port`    | Port parsed from the endpoint     |
| `db.namespace`   | Database path, e.g. `/local`      |

When `hooks: telemetry.hooks` is passed to `Driver`, per-RPC attributes are also set on the active span:

| Attribute              | Description                       |
| ---------------------- | --------------------------------- |
| `ydb.node.id`          | YDB node ID the RPC was routed to |
| `ydb.node.dc`          | Datacenter / availability zone    |
| `network.peer.address` | gRPC peer host                    |
| `network.peer.port`    | gRPC peer port                    |
| `rpc.grpc.status_code` | gRPC status code on completion    |

On error, every span gets:

| Attribute                 | Description                                                            |
| ------------------------- | ---------------------------------------------------------------------- |
| `db.response.status_code` | YDB or gRPC status name (`OVERLOADED`, `UNAVAILABLE`, `TIMEOUT`, etc.) |
| `error.type`              | Same value (follows OTel semconv for DB spans)                         |

### Span catalogue

#### Driver

| Span name        | Kind     | Source channel            | Attributes                                                |
| ---------------- | -------- | ------------------------- | --------------------------------------------------------- |
| `ydb.DriverInit` | INTERNAL | `tracing:ydb:driver.init` | `db.namespace`, `server.address`, `ydb.discovery.enabled` |

#### Discovery

| Span name       | Kind   | Source channel          | Attributes                                                                                                                                                                                            |
| --------------- | ------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ydb.Discovery` | CLIENT | `tracing:ydb:discovery` | `db.namespace`, `ydb.discovery.periodic`; enriched on `ydb:discovery.completed`: `ydb.discovery.added_count`, `ydb.discovery.removed_count`, `ydb.discovery.total_count`, `ydb.discovery.duration_ms` |

#### Auth

| Span name        | Kind     | Source channel                 | Attributes          |
| ---------------- | -------- | ------------------------------ | ------------------- |
| `ydb.TokenFetch` | INTERNAL | `tracing:ydb:auth.token.fetch` | `ydb.auth.provider` |

`ydb.auth.provider` values: `static`, `metadata`, `iam`, `access_token`, `anonymous`.

#### Session pool

| Span name            | Kind     | Source channel                | Attributes                                                         |
| -------------------- | -------- | ----------------------------- | ------------------------------------------------------------------ |
| `ydb.AcquireSession` | INTERNAL | `tracing:ydb:session.acquire` | `ydb.session.kind` (`query` or `transaction`)                      |
| `ydb.CreateSession`  | CLIENT   | `tracing:ydb:session.create`  | `ydb.pool.live_sessions`, `ydb.pool.max_size`, `ydb.pool.creating` |

#### Connection pool events

Zero-duration event spans emitted under the currently active subscriber span:

| Span name                          | Attributes                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------ |
| `ydb.pool.connection.added`        | `ydb.node.id`, `ydb.node.dc`, `network.peer.address`                                       |
| `ydb.pool.connection.pessimized`   | `ydb.node.id`, `ydb.node.dc`, `network.peer.address`                                       |
| `ydb.pool.connection.unpessimized` | `ydb.node.id`, `ydb.node.dc`, `network.peer.address`, `ydb.pool.pessimization.duration_ms` |
| `ydb.pool.connection.retired`      | `ydb.node.id`, `ydb.node.dc`, `network.peer.address`, `ydb.pool.retire.reason`             |
| `ydb.pool.connection.removed`      | `ydb.node.id`, `ydb.node.dc`, `network.peer.address`, `ydb.pool.remove.reason`             |

#### Retry

| Span name          | Kind     | Source channel              | Attributes                                                    |
| ------------------ | -------- | --------------------------- | ------------------------------------------------------------- |
| `ydb.RunWithRetry` | INTERNAL | `tracing:ydb:retry.run`     | `ydb.idempotent`                                              |
| `ydb.Try`          | INTERNAL | `tracing:ydb:retry.attempt` | `ydb.retry.attempt`, `ydb.idempotent`, `ydb.retry.backoff_ms` |

#### Query

| Span name          | Kind   | Source channel                  | Attributes                                                                                                                                        |
| ------------------ | ------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ydb.Transaction`  | CLIENT | `tracing:ydb:query.transaction` | `ydb.isolation`, `ydb.idempotent`                                                                                                                 |
| `ydb.Begin`        | CLIENT | `tracing:ydb:query.begin`       | `db.ydb.session_id`, `db.ydb.node_id`, `ydb.isolation`                                                                                            |
| `ydb.ExecuteQuery` | CLIENT | `tracing:ydb:query.execute`     | `db.query.text` (redacted unless `captureQueryText: true`), `db.ydb.session_id`, `db.ydb.node_id`, `ydb.idempotent`, `ydb.isolation`, `ydb.stage` |
| `ydb.Commit`       | CLIENT | `tracing:ydb:query.commit`      | `db.ydb.session_id`, `ydb.transaction.id`                                                                                                         |
| `ydb.Rollback`     | CLIENT | `tracing:ydb:query.rollback`    | `db.ydb.session_id`, `ydb.transaction.id`                                                                                                         |

`ydb.stage` values: `standalone` (single-shot query), `tx` (query inside a transaction body).

### Typical span tree

For a transactional query a complete trace looks like:

```
ydb.Transaction
└─ ydb.RunWithRetry
   └─ ydb.Try (attempt=1)
      ├─ ydb.AcquireSession
      │  └─ ydb.CreateSession   ← only when the pool grows
      ├─ ydb.Begin
      ├─ ydb.ExecuteQuery
      └─ ydb.Commit             ← or ydb.Rollback on body throw
```

## Metrics

All metrics are recorded via the global OTel `MeterProvider`. Pass `endpoint` to `register()` to populate `database` / `endpoint` labels on operation and retry metrics.

### Client operations

Covers `ExecuteQuery`, `Commit`, `Rollback`, and `CreateSession` RPCs.

| Metric                          | Type      | Unit          | Labels                                                  | Description                          |
| ------------------------------- | --------- | ------------- | ------------------------------------------------------- | ------------------------------------ |
| `ydb.client.operation.duration` | Histogram | `s`           | `operation.name`, `database`, `endpoint`                | Duration of a single client RPC call |
| `ydb.client.operation.failed`   | Counter   | `{operation}` | `operation.name`, `status_code`, `database`, `endpoint` | Number of failed client RPC calls    |

`operation.name` values: `ExecuteQuery`, `Commit`, `Rollback`, `CreateSession`.

Histogram buckets (seconds): `0.001 0.005 0.01 0.025 0.05 0.1 0.25 0.5 0.75 1 1.25 1.5 1.75 2 2.5 3 5 10`.

### Retry

| Metric                      | Type      | Unit        | Labels                                   | Description                                                          |
| --------------------------- | --------- | ----------- | ---------------------------------------- | -------------------------------------------------------------------- |
| `ydb.client.retry.duration` | Histogram | `s`         | `ydb.idempotent`, `database`, `endpoint` | Total wall-clock time of one `retry()` call (all attempts + backoff) |
| `ydb.client.retry.attempts` | Histogram | `{attempt}` | `ydb.idempotent`, `database`, `endpoint` | Number of attempts per `retry()` invocation; `1` = first-try success |

Histogram buckets:

- `retry.duration` (seconds): `0.01 0.05 0.1 0.25 0.5 0.75 1 1.25 1.5 1.75 2 2.5 3 5 10 30`
- `retry.attempts` (count): `1 2 3 5 10`

### Session pool

All session metrics share the label `ydb.query.session.pool.name`, set to the database path when `endpoint` is provided.

| Metric                               | Type             | Unit        | Labels                                                   | Description                                           |
| ------------------------------------ | ---------------- | ----------- | -------------------------------------------------------- | ----------------------------------------------------- |
| `ydb.query.session.create_time`      | Histogram        | `s`         | `ydb.query.session.pool.name`                            | Session creation latency                              |
| `ydb.query.session.pending_requests` | Counter          | `{request}` | `ydb.query.session.pool.name`                            | Requests that started waiting for a free session      |
| `ydb.query.session.timeouts`         | Counter          | `{timeout}` | `ydb.query.session.pool.name`                            | Session acquisition timeouts (`TimeoutError`)         |
| `ydb.query.session.count`            | Observable gauge | `{session}` | `ydb.query.session.pool.name`, `ydb.query.session.state` | Current session count by state (`active`, `creating`) |
| `ydb.query.session.max`              | Observable gauge | `{session}` | `ydb.query.session.pool.name`                            | Configured `MaxPoolSize`                              |
| `ydb.query.session.min`              | Observable gauge | `{session}` | `ydb.query.session.pool.name`                            | Configured `MinPoolSize`                              |

Histogram buckets for `create_time` (seconds): `0.001 0.005 0.01 0.025 0.05 0.1 0.25 0.5 1`.

## Logs

Logs are **disabled by default**. Enable with `logs: true`:

```ts
register({ logs: true })
```

Logs are emitted via the OTel Logs API (`logs.getLogger(...)`) and attached to the active OTel context. Each lifecycle event maps to a severity:

| Event channel                      | Severity |
| ---------------------------------- | -------- |
| `ydb:driver.ready`                 | INFO     |
| `ydb:driver.closed`                | WARN     |
| `ydb:discovery.completed`          | DEBUG    |
| `ydb:pool.connection.added`        | INFO     |
| `ydb:pool.connection.removed`      | INFO     |
| `ydb:pool.connection.pessimized`   | INFO     |
| `ydb:pool.connection.unpessimized` | DEBUG    |
| `ydb:session.created`              | INFO     |
| `ydb:session.closed`               | INFO     |
| `ydb:session.pool.exhausted`       | WARN     |
| `ydb:session.pool.queued`          | DEBUG    |
| `ydb:query.attempt.started`        | DEBUG    |
| `ydb:auth.token.refreshed`         | DEBUG    |
| `ydb:auth.token.expired`           | INFO     |
| `ydb:auth.provider.failed`         | WARN     |
| `ydb:retry.exhausted`              | WARN     |
| Tracing channel errors             | ERROR    |

## Advanced: granular installation

Instead of `register()`, you can install only what you need:

```ts
import {
  installContextManager,
  installTracing,
  installMetrics,
  installLogs,
} from '@ydbjs/telemetry'

const cmDisposer = installContextManager()
const traceDisposers = installTracing({ endpoint: 'grpc://localhost:2136/local' })
const metricDisposers = installMetrics({ endpoint: 'grpc://localhost:2136/local' })
const logDisposers = installLogs()

// Later:
cmDisposer()
traceDisposers.forEach((d) => d())
metricDisposers.forEach((d) => d())
logDisposers.forEach((d) => d())
```

## Development

```sh
npm run build   # compile TypeScript
npm test        # run vitest
```

## License

This project is licensed under the [Apache 2.0 License](../../LICENSE).

## Links

- [YDB Documentation](https://ydb.tech)
- [GitHub Repository](https://github.com/ydb-platform/ydb-js-sdk)
- [Issues](https://github.com/ydb-platform/ydb-js-sdk/issues)
- [OpenTelemetry JavaScript](https://opentelemetry.io/docs/languages/js/)
- [Tracing example](../../examples/telemetry/)
