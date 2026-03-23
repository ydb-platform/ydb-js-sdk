# Changelog

## v6.0.0

- Initial release
- OpenTelemetry instrumentation for QueryService operations: CreateSession, ExecuteQuery, Commit, Rollback
- Span attributes per OpenTelemetry DB Spans semconv: db.system, server.address, server.port, db.namespace
- Error attributes: db.response.status_code, error.type
- SpanKind = CLIENT for all operations
