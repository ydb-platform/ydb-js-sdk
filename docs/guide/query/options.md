---
title: Query — Options & API
---

# Options and API `@ydbjs/query`

This page provides a full overview of the query client API and its chainable options.

## Client and basic syntax

```ts
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'

using driver = new Driver(process.env['YDB_CONNECTION_STRING'] ?? 'grpc://localhost:2136/local')
await driver.ready()

await using sql = query(driver)
let [rows] = await sql`SELECT 1 AS one`
```

### Plain SQL and retry scopes

`new QueryClient(driver)` provides `retrySession(options, callback)` and `retryTransaction(options, callback)`; options may be omitted and the callback is always last.
The root client has no `execute()` or `stream()` methods: these belong to the executor passed into the callback.
`retrySession()` owns one session per attempt; `retryTransaction()` groups statements in a transaction.
The callback can run more than once, so create accumulators inside it and account for repeated external effects.
Consume streams before leaving the callback; an early `break` cancels the RPC and does not count as successful completion.

```ts
import { QueryClient } from '@ydbjs/query'

type Row = { id: bigint }

await using client = new QueryClient(driver)

let result = await client.retrySession(
  { signal: AbortSignal.timeout(5000), idempotent: true },
  (session) => {
    return session.execute<[Row]>('SELECT $id AS id', { id: 42n })
  }
)

console.log(result.resultSets[0].rows[0]?.id)
```

`query(client)` creates a tagged interface sharing the client's pool and lifecycle.
`close()` waits for accepted work; `destroy()` cancels it immediately.
Neither closes the supplied `Driver`; close it after its clients.

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

let result = await client.retrySession((session) => {
  return session.execute<[UserRow, CountRow]>(
    'SELECT id FROM users; SELECT COUNT(*) AS count FROM users;'
  )
})

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
  - Modes: `'implicit' | 'serializableReadWrite' | 'snapshotReadOnly' | 'snapshotReadWrite' | 'onlineReadOnly' | 'staleReadOnly'`.
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

- `signal(abortSignal)` — set an external cancellation signal. A later call replaces it; use `AbortSignal.any()` to combine several signals.

- `execute()` — start execution and return the same `Query<T>`. Await the handle to observe the result or failure.

- `cancel()` — cancel execution. Equivalent to `controller.abort()` for the internal AbortController.

## Query events

`Query<T>` instances emit events via `on(event, listener)`:

- `retry` — receives a `RetryContext` when a standalone query retries. To observe callback retries, use the `onRetry` option of `retrySession()` or `retryTransaction()`.
- `stats` — execution stats if `withStats()` is enabled.
- `done` — receives an array of result sets, each an array of rows, with the same shape as `await query`.
- `error` — receives an execution error when a listener is registered. Await the query handle to observe its rejection.
- `cancel` — receives no arguments and fires on an explicit `query.cancel()` call. External signal cancellation and timeouts do not emit this event.
- `metadata` — gRPC trailers (e.g., server hints/headers).

```ts
import { StatsMode } from '@ydbjs/api/query'

let q = sql`SELECT * FROM users`.withStats(StatsMode.FULL)

q.on('retry', (ctx) => {
  console.log('retry', ctx.attempt, ctx.error)
})

q.on('stats', (s) => {
  console.log('cpu(us)', s.totalCpuTimeUs)
})

await q
```

## Parameters and types

Value interpolations `${...}` are parameterized and converted through `@ydbjs/value`; `identifier()`, `fragment()` and `unsafe()` insert SQL structure instead.

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

- YDB statuses `ABORTED/OVERLOADED/UNAVAILABLE/BAD_SESSION/SESSION_BUSY` are retryable while the callback budget and cancellation signal allow it.
- YDB statuses `SESSION_EXPIRED/UNDETERMINED/TIMEOUT` require `idempotent(true)`. Transport failures have a separate policy: gRPC `INTERNAL` and `UNAVAILABLE` also require idempotency. Caller cancellation and local timeouts end the operation.

```ts
try {
  await sql`SELECT * FROM heavy_table`.idempotent(true).timeout(5000)
} catch (e) {
  // e instanceof YDBError
}
```
