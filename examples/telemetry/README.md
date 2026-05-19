# YDB OpenTelemetry Example

Wires `@ydbjs/telemetry` into a standard OpenTelemetry Node SDK setup and
exports both **traces** and **metrics** over OTLP/HTTP. Demonstrates:

- Starting `NodeSDK` before YDB code runs so the global `TracerProvider` /
  `MeterProvider` / `ContextManager` are in place when
  `@ydbjs/telemetry` subscribes.
- Calling `register({ ... })` to enable the instrumentation.
- Wrapping the workload in a user-created span — `@ydbjs/core`'s propagation
  middleware reads `context.active()` on every outgoing gRPC call and
  injects W3C `traceparent` / `tracestate` headers so the YDB server sees
  the same trace id.
- Graceful teardown that flushes pending telemetry before the process exits.

## Run

```bash
# Defaults to grpc://localhost:2136/local and OTLP http://localhost:4318.
node index.js

# Or point at a real collector / cluster:
YDB_CONNECTION_STRING=grpcs://your.host:2135/?database=/ru/your/database \
OTEL_EXPORTER_OTLP_ENDPOINT=http://collector.local:4318 \
  node index.js
```

A quick local collector (one of):

- [Jaeger ≥ 1.50](https://www.jaegertracing.io/docs/latest/getting-started/) —
  ships with an OTLP/HTTP receiver on `:4318`.
- [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/) — full
  pipeline, can fan out to Jaeger + Prometheus + your APM of choice.

## What you should see

In your collector UI:

- A root `demo.workload` span (your own).
- Children: `ydb.Query.ExecuteQuery` (for the standalone `SELECT 1`) and
  `ydb.Query.BeginTransaction` → `ydb.Query.ExecuteQuery` × 2 →
  `ydb.Query.CommitTransaction` for the transaction block.
- Pool lifecycle spans (`ydb.AttachSession`, `ydb.DeleteSession`) once the
  example shuts down.

In Prometheus / your metrics backend:

- `db_client_operation_duration` histogram, tagged by `db.operation.name`.
- `ydb_query_session_count` / `ydb_query_session_create_duration` / etc.

## Tweaks

| Knob                     | Where                                  | Default                                |
| ------------------------ | -------------------------------------- | -------------------------------------- |
| `captureQueryText`       | `register({ … })`                      | `false`                                |
| `emitAcquireSessionSpan` | `register({ … })`                      | `false`                                |
| Service name             | `new NodeSDK({ … })`                   | —                                      |
| Metric export interval   | `PeriodicExportingMetricReader({ … })` | `5_000ms` here, `60_000ms` SDK default |

See `packages/telemetry/README.md` for the full attribute / metric / span
catalogue.
