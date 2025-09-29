---
title: Query — Options & API
---

# Options and API `@ydbjs/query`

This page provides a full overview of the query client API and its chainable options.

## Client and basic syntax

```ts
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'

let driver = new Driver(process.env.YDB_CONNECTION_STRING!)
await driver.ready()

let sql = query(driver)
let rows = await sql`SELECT 1 AS one`
```

## Chainable query options

- `idempotent(flag?: boolean)` — marks a single call as idempotent, which enables retries for conditionally retryable error codes.
  - Note: ignored inside `sql.begin`/`sql.transaction`.

- `isolation(mode, settings?)` — sets isolation for a single call.
  - Modes: `'implicit' | 'serializableReadWrite' | 'snapshotReadOnly' | 'onlineReadOnly' | 'staleReadOnly'`.
  - Inside an active transaction, isolation is configured only at `sql.begin({ isolation })` / `sql.transaction(...)`. Applying `.isolation(...)` to `tx\`...\`` has no effect for a single statement.

- `timeout(ms: number)` — total timeout for a single call; used when composing the AbortSignal.

- `withStats(mode)` and `stats()` — enables QueryStats and lets you access them after await:
  - mode: StatsMode.<...> from `@ydbjs/api/query` (e.g., StatsMode.FULL).

- `values()` and `raw()` — result formats:
  - Default: array of objects `{ columnName: value }`.
  - `values()`: array of arrays in column order.
  - `raw()`: return raw wire values (TypedValue) without converting to JS.

- `syntax(mode)` — text syntax (default `YQL_V1`).

- `pool(poolId)` — target pool (if configured server‑side by YDB Query services).

- `parameter(name, value)` / `param(name, value)` — add/override a named parameter.

- `signal(abortSignal)` — merge an external AbortSignal.

- `execute()` — start execution “from outside” and get the same `Query<T>` (useful for fire‑and‑forget with events).

- `cancel()` — cancel execution. Equivalent to `controller.abort()` for the internal AbortController.

## Query events

`Query<T>` instances emit events via `on(event, listener)`:

- `retry` — fired on retry; good for logging.
- `stats` — execution stats if `withStats()` is enabled.
- `done` — completed with result.
- `error` — execution error.
- `cancel` — user cancellation.
- `metadata` — gRPC trailers (e.g., server hints/headers).

```ts
const q = sql`SELECT * FROM users`.withStats(StatsMode.FULL)
q.on('retry', (ctx) => console.log('retry', ctx.attempt, ctx.error))
q.on('stats', (s) => console.log('cpu', s.queryPhaseStats?.cpuTimeUs))
await q
```

## Parameters and types

Interpolations `${...}` are always parameterized and automatically converted through `@ydbjs/value`.

- Named parameters:

```ts
await sql`SELECT * FROM users WHERE id = $id`.parameter('id', 42)
```

- Complex types (arrays, structs) and table parameters via `AS_TABLE(${arrayOfObjects})`.

- Dynamic identifiers and “unsafe” fragments:
  - `sql.identifier(name)` — escapes and quotes table/column identifiers.
  - `sql.unsafe(text)` — for trusted migrations/service statements; never pass user input.

## Errors and retries

Queries throw `YDBError` (or others) on failure. Retries are governed by `idempotent()` and error codes.

- `ABORTED/OVERLOADED/UNAVAILABLE/BAD_SESSION/SESSION_BUSY` — always retried.
- `SESSION_EXPIRED/UNDETERMINED/TIMEOUT` — retried only with `idempotent(true)`.

```ts
try {
  await sql`SELECT * FROM heavy_table`.idempotent(true).timeout(5000)
} catch (e) {
  // e instanceof YDBError
}
```
