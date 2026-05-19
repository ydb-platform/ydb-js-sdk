# YDB Telemetry Example

Demonstrates how to instrument the YDB JavaScript SDK with OpenTelemetry tracing using `@ydbjs/telemetry`.

## What it does

- Starts `@opentelemetry/sdk-node` with an `OTLPTraceExporter`
- Registers `@ydbjs/telemetry` to subscribe to SDK `diagnostics_channel` events
- Runs a `SELECT 1` and a two-query transaction
- Exports spans to an OTLP collector (Jaeger, Grafana Tempo, OpenTelemetry Collector)

## Run

Requires a collector listening on `http://localhost:4318` (default OTLP/HTTP endpoint):

```sh
YDB_CONNECTION_STRING=grpc://localhost:2136/local node index.js
```

Custom collector URL:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node index.js
```

## See also

- [`examples/diagnostics/`](../diagnostics/) — raw channel events without OTel
- [`@ydbjs/telemetry` README](../../packages/telemetry/README.md) — full API reference
