# YDB Diagnostics Channel Example

Subscribes to a selection of `node:diagnostics_channel` events from the SDK
packages (`@ydbjs/core`, `@ydbjs/retry`, `@ydbjs/auth`, `@ydbjs/query`),
runs one `SELECT` and one transaction, and prints the full event stack to
the console in the order the events fire.

The goal is to show how a single subscriber can build traces, metrics, and
logs on top of the SDK without pulling in OpenTelemetry or any other
telemetry stack.

## Run

```sh
npm install
YDB_CONNECTION_STRING=grpc://localhost:2136/local npm start
```

Default connection string: `grpc://localhost:2136/local`. Diagnostic output includes selected lifecycle fields and error names; it excludes query text, parameter values, tokens, and error messages. The demonstration query results are printed separately.

Discovery is **off by default** because containerised local-ydb advertises
an internal hostname that's unreachable from the host. To see the full
discovery / pool activity, run a `local-ydb` container with `--hostname localhost` and pass
`ENABLE_DISCOVERY=1`:

```sh
docker run -d --rm --name ydb-diag-demo --hostname localhost \
  -p 2136:2136 ydbplatform/local-ydb:latest

ENABLE_DISCOVERY=1 \
  YDB_CONNECTION_STRING=grpc://localhost:2136/local \
  npm start
```

## Abbreviated output shape (discovery off)

```
# diagnostics example
# discovery=off

+    7.0ms ● ydb:driver.ready  duration=4.3

# 1. single-shot SELECT 1

+    8.0ms ┌─ tracing:ydb:retry.run  idempotent=false
+    8.2ms   ┌─ tracing:ydb:retry.attempt  attempt=1 idempotent=false
+    8.3ms     ┌─ tracing:ydb:query.session.acquire
+    8.4ms       ┌─ tracing:ydb:query.session.create
+   30.0ms       └─ tracing:ydb:query.session.create ✓
+   30.1ms       ● ydb:query.session.created  sessionId="ydb://session/3?…" nodeId=1n
+   30.2ms     └─ tracing:ydb:query.session.acquire ✓
+   30.3ms     ┌─ tracing:ydb:query.execute  sessionId="…" nodeId=1n idempotent=false isolation="implicit"
+   38.2ms     └─ tracing:ydb:query.execute ✓
+   38.3ms   └─ tracing:ydb:retry.attempt ✓
+   38.4ms └─ tracing:ydb:retry.run ✓

  → result: {"n":1}
```

With `ENABLE_DISCOVERY=1`, the example also prints `tracing:ydb:driver.discovery`, `ydb:driver.connection.added`, and `ydb:driver.discovery.completed`. Query session events use the `ydb:query.session.*` prefix. The sample output is abbreviated; timings and interleaving depend on the database.

## What you can learn from this

- **Event ordering**. `tracing:` channels fire `start` before the work
  begins and `asyncEnd` after it completes; nesting reflects the actual
  call hierarchy via `AsyncLocalStorage`.
- **Retry hierarchy**. `tracing:ydb:retry.*` come from `@ydbjs/retry` and
  nest under whichever caller invoked `retry()` — discovery, query,
  transaction, auth — without any per-callsite import.
- **Public contract**. The channel names and payload fields you see here
  are SemVer-stable. See each package's README for the full table.

## Important

`node:diagnostics_channel` invokes subscribers synchronously. Node reports a thrown subscriber error as an uncaught exception on a later tick. Wrap production subscriber logic in `try/catch`; catching around the SDK call does not contain the error.
