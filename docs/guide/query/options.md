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

### Temporal result conversion

Configure result conversion when creating the client with `query(driver, { temporal: true })` or `new QueryClient(driver, { temporal: true })`.
`query(client)` inherits that setting, which applies to buffered and streamed results and recursively to nested values.
It is a client option, not a chainable query method, and does not affect parameter inference.

The application must provide `globalThis.Temporal` before enabling this option; the SDK does not bundle or install a polyfill.
Runtimes with native Temporal need no setup; on Node.js 22/24, the application can install `temporal-polyfill` and import `temporal-polyfill/global` at startup.
The client throws during construction if Temporal is unavailable.
Raw results bypass conversion, and TzDate/TzDate32 remain SDK Values in both modes.
See the [value package's setup, input rules and result mapping](https://github.com/ydb-platform/ydb-js-sdk/tree/main/packages/value#temporal-setup).

### Result sets

`session.execute()` returns a `QueryResult<T>` object with `resultSets`, `stats` and `metadata`.
Each result set contains `rows`, `columns` and `truncated`; empty result sets preserve their position and schema.
Tagged SQL returns an array of row arrays; use the query handle's methods and events for statistics and metadata.
The type argument is a tuple of row types, with one entry per result set; it does not validate the server schema at runtime.
Streaming keeps its row type argument: `session.stream<Row>()` yields parts with `rows`, `columns`, `truncated` and `resultSetIndex` inside the retry callback.

```ts
import { QueryClient } from '@ydbjs/query'

type UserRow = { id: bigint }
type CountRow = { count: bigint }

let [users, counts] = await sql<[UserRow, CountRow]>`
  SELECT id FROM users;
  SELECT COUNT(*) AS count FROM users;
`

console.log(users[0]?.id, counts[0]?.count)

await using client = new QueryClient(driver)

let result = await client.retrySession((session) =>
  session.execute<[UserRow, CountRow]>('SELECT id FROM users; SELECT COUNT(*) AS count FROM users;')
)

console.log(result.resultSets[0].rows[0]?.id, result.resultSets[1].rows[0]?.count)
console.log(
  result.resultSets[0].columns,
  result.resultSets[0].truncated,
  result.stats,
  result.metadata
)
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
  - Default: each result set contains objects `{ columnName: value }`.
  - `values()`: each result set contains row arrays in column order.
  - `raw()`: return protobuf `Ydb.Value` cells from `@ydbjs/api/value` without converting to JS. These cells do not include their type; use `QueryClient` result-set `columns` when the schema is needed.

- `syntax(mode)` — text syntax (default `YQL_V1`).

- `pool(poolId)` — target pool (if configured server‑side by YDB Query services).

- `parameter(name, value)` / `param(name, value)` — bind a JavaScript value or an explicit YDB Value by name. Pass `undefined` to remove the binding.

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
await sql`SELECT $id AS id`.parameter('id', 42)
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
