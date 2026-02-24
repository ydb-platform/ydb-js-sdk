# @ydbjs/tracing

OpenTelemetry tracing for YDB JavaScript SDK. Used internally by `@ydbjs/core` to instrument QueryService operations according to [OpenTelemetry Database Spans semantic conventions](https://opentelemetry.io/docs/specs/semconv/db/database-spans/).

## Instrumented operations

Spans are created **automatically** in the gRPC middleware layer when these QueryService methods are called:

- **ydb.CreateSession** — CreateSession
- **ydb.ExecuteQuery** — ExecuteQuery (including streaming)
- **ydb.Commit** — CommitTransaction
- **ydb.Rollback** — RollbackTransaction

## Span attributes

All spans include:

- `db.system` = "ydb"
- `server.address` — logical host from client config
- `server.port` — port (number)
- `db.namespace` — database path (if available)

On error:

- `db.response.status_code` — YDB status code (e.g. UNAVAILABLE, BAD_REQUEST)
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
