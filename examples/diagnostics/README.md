# YDB Diagnostics Channel Example

Subscribes to every `node:diagnostics_channel` event published by the SDK
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

Default connection string: `grpc://localhost:2136/local`.

Discovery is **off by default** because containerised local-ydb advertises
an internal hostname that's unreachable from the host. To see the full
discovery / pool flow (`tracing:ydb:discovery`, `ydb:pool.connection.added`,
…), run a `local-ydb` container with `--hostname localhost` and pass
`ENABLE_DISCOVERY=1`:

```sh
docker run -d --rm --name ydb-diag-demo --hostname localhost \
  -p 2136:2136 ydbplatform/local-ydb:latest

ENABLE_DISCOVERY=1 \
  YDB_CONNECTION_STRING=grpc://localhost:2136/local \
  npm start
```

## Sample output (default run, discovery off)

```
# diagnostics example, connecting to grpc://localhost:2136/local
# discovery=off

+    7.0ms ● ydb:driver.ready  database="/local" duration=4.3

# 1. single-shot SELECT 1

+    8.0ms ┌─ tracing:ydb:retry.run  idempotent=false
+    8.2ms   ┌─ tracing:ydb:retry.attempt  attempt=1 idempotent=false
+    8.3ms     ┌─ tracing:ydb:session.acquire  kind="query"
+    8.4ms       ┌─ tracing:ydb:session.create  liveSessions=0 maxSize=50 creating=0
+   30.0ms       └─ tracing:ydb:session.create ✓
+   30.1ms       ● ydb:session.created  sessionId="ydb://session/3?…" nodeId=1n
+   30.2ms     └─ tracing:ydb:session.acquire ✓
+   30.3ms     ┌─ tracing:ydb:query.execute  text="SELECT 1 AS n" sessionId="…" nodeId=1n idempotent=false isolation="implicit" stage="standalone"
+   38.2ms     └─ tracing:ydb:query.execute ✓
+   38.3ms   └─ tracing:ydb:retry.attempt ✓
+   38.4ms └─ tracing:ydb:retry.run ✓

  → result: {"n":1}
```

With `ENABLE_DISCOVERY=1` the run additionally emits `tracing:ydb:discovery`,
`ydb:pool.connection.added`, and `ydb:discovery.completed` before the first
query.

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

`node:diagnostics_channel` invokes subscribers **synchronously**. A
subscriber that throws will disrupt the SDK. Wrap your real subscriber
logic in `try/catch`.
