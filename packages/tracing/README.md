# @ydbjs/tracing

OpenTelemetry tracing for YDB JavaScript SDK. Used internally by `@ydbjs/core` to instrument QueryService operations according to [OpenTelemetry Database Spans semantic conventions](https://opentelemetry.io/docs/specs/semconv/db/database-spans/).

## Instrumented operations

Spans are created **automatically** in the gRPC middleware layer when these QueryService methods are called:

- **ydb.CreateSession** — CreateSession
- **ydb.ExecuteQuery** — ExecuteQuery (including streaming)
- **ydb.Commit** — CommitTransaction
- **ydb.Rollback** — RollbackTransaction

## Span attributes

- `db.system.name` = "ydb"
- `server.address` — logical host from connection string
- `server.port` — port (number)
- `network.peer.address` — actual node address (after discovery or same as server when disabled)
- `network.peer.port` — actual node port
- `db.namespace` — database path (if available)
- `ydb.node.id` — node id (when using discovery)
- `ydb.node.dc` — node location/datacenter (when available)

The `traceparent` header (W3C Trace Context) is set on gRPC metadata for propagation. Spans created via `createOpenTelemetryTracer()` implement `getId()` returning the traceparent string.

On error:

- `db.response.status_code` — YDB status code (e.g. UNAVAILABLE, BAD_REQUEST, CANCELLED)
- `error.type` — normalized error type

## Usage

To collect traces:

1. Install `@opentelemetry/sdk-trace-node` and an exporter (e.g. `@opentelemetry/exporter-trace-otlp-http`).
2. Configure a `TracerProvider` before using the driver:

```typescript
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'

const provider = new NodeTracerProvider()
provider.addSpanProcessor(new BatchSpanProcessor(new OTLPTraceExporter()))
provider.register()
```

3. Use `@ydbjs/query` or `@ydbjs/core` as usual — spans are created automatically for instrumented gRPC calls.

4. Pass the tracer to the Driver: `new Driver(url, { tracer: createOpenTelemetryTracer() })`.

### Span.getId() and SpanFinalizer

Spans from `createOpenTelemetryTracer()` implement `getId()` returning a W3C `traceparent` string for propagation. For manual span completion you can use `SpanFinalizer`:

```typescript
import { SpanFinalizer } from '@ydbjs/tracing'

// On success
SpanFinalizer.finishSuccess(span)

// On error
SpanFinalizer.finishByError(span, error)

// Callback for async completion: (error) => ...
const done = SpanFinalizer.whenComplete(span)
promise.then(
  () => done(null),
  (err) => done(err)
)
```

## Viewing traces in Grafana (localhost:3000)

The repo's local stack includes Grafana and Tempo. To see YDB traces in Grafana:

1. **Start the stack** (from repo root):

   ```bash
   docker compose -f docker-compose.local.yml up -d
   ```

2. **Send traces to Tempo** — point the OTLP exporter at Tempo (OTLP HTTP on port 4318).  
   **From the host:** `url: 'http://localhost:4318/v1/traces'`.  
   **From a container on the same Docker network as Tempo:** `url: 'http://tempo:4318/v1/traces'`.

   ```typescript
   import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
   import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
   import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'

   const provider = new NodeTracerProvider()
   provider.addSpanProcessor(
     new BatchSpanProcessor(
       new OTLPTraceExporter({ url: 'http://localhost:4318/v1/traces' }) // or http://tempo:4318/v1/traces from Docker
     )
   )
   provider.register()
   ```

   Then use the driver as usual; spans will be sent to Tempo.  
   **Note:** Vitest tracing tests use `InMemorySpanExporter` and do not send data to Tempo; run your app (e.g. `node test-ydb.js`) to see traces in Grafana.

3. **Tempo datasource in Grafana**  
   The stack provisions a Tempo datasource automatically (URL `http://tempo:3200`). If you added Tempo manually before and see "Failed to connect", remove the old datasource in **Connections** → **Data sources** and restart Grafana, or use the provisioned "Tempo" source.

4. **View traces**
   - **Explore** (compass icon) → choose **Tempo**.
   - **Search**: e.g. span name `ydb.CreateSession`, or filter by attribute.
   - **TraceQL** (recommended): use the same attribute names as in the SDK, e.g.:
     - `{ .db.system.name = "ydb" }` — all YDB spans
     - `{ .name = "ydb.ExecuteQuery" }` — only ExecuteQuery
     - `{ .db.namespace = "/local" }` — spans for database `/local`
   - Run a few YDB operations in your app, then search for recent traces.
