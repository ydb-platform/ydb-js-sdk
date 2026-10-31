# @ydbjs/query

[![codecov](https://codecov.io/gh/ydb-platform/ydb-js-sdk/graph/badge.svg?component=query)](https://ydb-appteam-sdk-reports.website.yandexcloud.net/ydb-js-sdk/coverage/packages/query/)

Read this in Russian: [README.ru.md](README.ru.md)

The `@ydbjs/query` package provides a tagged template API and a raw SQL client for executing YQL queries and managing transactions in YDB. Both share parameter conversion, session pooling, and retry handling.

## Features

- Tagged template syntax for YQL queries
- Plain SQL execution and streaming inside explicit retry callbacks
- Type-safe, automatic parameter binding (including complex/nested types)
- Transaction helpers with isolation and idempotency options
- Multiple result sets and streaming support
- Query statistics and diagnostics
- Full TypeScript support

## Installation

```sh
npm install @ydbjs/core @ydbjs/query
```

## How It Works

- **Tagged Queries**: `query(driver)` returns a tagged template function with automatic parameter binding and transaction helpers.
- **Raw SQL Client**: `new QueryClient(driver)` exposes `retrySession(options, callback)` and `retryTransaction(options, callback)`. Options may be omitted; the callback is always last. It receives a session or transaction executor and the current attempt's cancellation signal. `query(client)` adds the tagged interface to that client's pool and lifecycle.
- **Session Pool**: Sessions are automatically pooled and reused between queries and transactions (default pool size: 50). Configure with `query(driver, { poolOptions: { maxSize: 100 } })`.
- **Sessions & Transactions**: Sessions and transactions are managed automatically. You can run single queries or group multiple queries in a transaction with `begin`/`transaction`.
- **Parameter Binding**: Parameters are bound by interpolation (`${}`) in the template string. Native JS types, YDB value classes, and arrays/objects are all supported. Use `.parameter()`/`.param()` for named parameters.
- **Type Safety**: All values are converted using `@ydbjs/value` (see its docs for details). Complex/nested types and arrays are handled automatically.
- **Result Sets**: Most queries return an array of result sets (YDB supports multiple result sets per query).
- **Query Statistics**: Use `.withStats()` or `.stats()` to access execution statistics.

## Usage

### Plain SQL and streaming

V7 exports the raw `QueryClient` class from `@ydbjs/query`. Its execution entry points are `retrySession(options, callback)` and `retryTransaction(options, callback)`, or `retrySession(callback)` and `retryTransaction(callback)` with default options. The callback is always the last argument. The client also owns `close()`, `destroy()` and structured disposal. Each callback receives `(session, signal)` for one attempt. The executor accepts SQL text unchanged, a named parameter object, and statement options. Use explicit YQL `DECLARE` statements when the database does not enable implicit parameter types.

The previous callable `QueryClient` type is named `SQLClient`. `query(driver)` and `query(client)` provide the convenient tagged API, including `sql.do()`, `sql.begin()` and `sql.transaction()`. `query(client)` shares the raw client's pool and lifecycle.

Each scoped statement snapshots its parameters when `execute()` or `stream()` is called. A retried callback may deliberately construct different parameters on its next attempt. A standalone tagged query instead fixes its text, settings and parameter values before its first attempt and reuses those bindings on retries.

```ts
import { QueryClient, query } from '@ydbjs/query'
import { Uint64 } from '@ydbjs/value/primitive'

await using client = new QueryClient(driver)
let text = 'DECLARE $id AS Uint64; SELECT $id AS id;'
let parameters = { id: new Uint64(42n) }
let signal = AbortSignal.timeout(30_000)
let result = await client.retrySession({ signal, idempotent: true }, (session) =>
  session.execute(text, parameters, { timeout: 5000 })
)

let sql = query(client)
let rows = await sql`SELECT ${new Uint64(42n)} AS id`
```

`session.execute()` returns `{ resultSets, stats, metadata }` after collecting the response. `session.stream()` returns response parts and is available only inside a retry callback. The root `QueryClient` has no `execute()`, `stream()`, `do()` or `transaction()` methods. A scoped stream retains only the current response parts, transport buffers and result schemas. Its memory use depends on part size, row size and concurrent operations, rather than the total result size. `responsePartLimitBytes` is a server-side packing target, not a strict JavaScript heap limit. `summary` becomes available only after successful full consumption.

The SDK owns the retry loop for every streaming operation. A stream does not independently replay rows; its failure reaches the surrounding retrier, which repeats the complete callback when allowed. Statement options reject `retry`, `idempotent` and `onRetry`: these belong to the callback. A failed attempt closes its streams before releasing its session. Unconsumed streams reject the callback, and executors or streams retained outside the callback cannot start further work. An early `break` cancels the RPC; a callback scope requires full consumption to succeed. `return()`, `cancel()` and async disposal also stop a pending `next()`.

```ts
let total = await client.retrySession(
  { signal, idempotent: true, retry: { budget: 3 } },
  async (session) => {
    let total = 0n
    for await (let part of session.stream<{ id: bigint }>(text, parameters)) {
      for (let row of part.rows) total += row.id
    }
    return total
  }
)
```

The accumulator belongs to an attempt. External effects performed by the callback also repeat; a read-only SQL statement does not make those effects idempotent. `idempotent: false` does not disable retries for definite-abort statuses: the entire callback must be safe to restart. `retrySession()` reuses a session for the attempt but does not make its statements atomic. Use `retryTransaction()` when a group of database writes must roll back together. The SDK does not resume an arbitrary `ExecuteQuery` at the last delivered row. Caller cancellation ends the retry budget and does not establish whether a write committed.

Callback options own `signal`, `timeout`, `retry`, `idempotent` and `onRetry`. The second callback argument is the current attempt's signal; pass it to application work that needs to stop when the attempt is cancelled. Statements may add a `signal` or `timeout` cap within the callback's remaining budget, but cannot replace its retry policy. Transaction isolation belongs to `retryTransaction()` options; statement isolation is available only in `retrySession()`.

```ts
let result = await client.retryTransaction(
  { signal, isolation: 'snapshotReadOnly', idempotent: true },
  (tx) => tx.execute(text, parameters)
)
```

`retryTransaction()` retries the complete transaction callback when the failure policy permits it. `beforeCommit()` runs before the commit RPC, including transactional Topic preparation; the historical `onCommit()` spelling remains as a compatibility alias. `onClose()` runs during completion cleanup, and a failure there never replays a confirmed commit. Its `committed: false` argument means that commit was not confirmed; it does not prove rollback when the outcome is unknown. The original uncertain commit error is preserved even when rollback returns `NOT_FOUND`.

Commit hooks must be registered before preparation starts. A hook may execute statements, but registering another commit hook from it throws instead of silently skipping that work.

A failed completion hook after confirmed commit rejects with `TransactionCompletionError` (`committed: true`), exported by `@ydbjs/query` and `@ydbjs/error`. Its `cause` preserves the original hook error. SDK retriers treat this error as terminal even if that cause is a retryable YDB error; this also prevents an enclosing retry scope from repeating a committed write. V7 callers that previously compared a close-hook error by identity should inspect `cause`.

Caller cancellation stops waiting for application hooks even when they ignore their signal; rollback RPC cleanup uses a separate bounded budget. Cancellation after an observed successful commit also returns `TransactionCompletionError`. Other cancellation reasons retain their identity unless the reason itself is a retryable database or session error: those are wrapped in an `AbortError` with the original reason as `cause`, so an enclosing retry callback cannot mistake cancellation for a database failure.

### Ownership and retry boundaries

The raw client makes callback replay explicit for both buffered and streaming queries. The tagged API supplies convenient query handles over the same execution engine; the raw executor returns a Promise or a scoped stream directly. The [executable example](../../examples/query-clients/src/demo.ts) demonstrates both interfaces sharing one client.

The callback boundary follows YDB [Go Do/DoTx](https://github.com/ydb-platform/ydb-go-sdk/blob/229af32f876ca3e96ab962436cd670cb2e174872/QUERY.md#L8-L22): collect buffered results and consume streams inside the attempt. The executor's `execute()` always materializes results and `stream()` always returns parts, including inside a transaction.

MongoDB also uses callback-bound ownership: [withSession](https://github.com/mongodb/node-mongodb-native/blob/main/src/mongo_client.ts) owns cleanup, while [withTransaction](https://github.com/mongodb/node-mongodb-native/blob/main/src/sessions.ts) can repeat its callback. The names `retrySession` and `retryTransaction` expose that replay contract directly. YDB's commit semantics differ, so MongoDB's commit retry algorithm is not copied.

node-postgres separates [Promise results and streaming cursors](https://node-postgres.com/apis/cursor), but its [manual transaction pattern](https://node-postgres.com/features/transactions) leaves connection release and rollback to the application. This SDK keeps those responsibilities inside its retry callbacks. [Postgres.js's lazy Query and cursor](https://github.com/porsager/postgres/blob/411429e7bd7a3d61155ca9a70a97c111823702ea/src/query.js#L74-L163) illustrates a convenient query handle; this package keeps that convenience in the tagged API. It does not combine an EventEmitter, Promise and row stream into one raw return value; node-postgres documents the [ambiguities of that combination](https://github.com/brianc/node-postgres/blob/master/docs/pages/guides/upgrading.md). YDB response parts are not PostgreSQL portal fetches, so a cursor row-count setting would imply a guarantee the protocol does not provide.

### Examples

After building the workspace, use a disposable local YDB and run the [raw-client and tagged-query example](../../examples/query-clients/src/demo.ts) directly:

```sh
export YDB_CONNECTION_STRING='grpc://localhost:2136/local'
node examples/query-clients/dist/demo.js
```

The [memory example](../../examples/query-clients/src/memory.ts) consumes a stream inside `retrySession()` and validates row count, payload length and an ID checksum without collecting rows. It reports completed payload bytes, sampled peak memory and retained memory after a final GC; there is no forced GC during consumption. Use 16 rows for 1 MiB, 16384 for 1 GiB or 65536 for 4 GiB. The optional final argument is the consumer pause per part in milliseconds (default: 1).

```sh
node --expose-gc --max-old-space-size=128 examples/query-clients/dist/memory.js 16384 1
```

Server invariants were checked in YDB 25.3.1.25 (`8187ce049bed9e63a5ec04769da2d83dd237c08a`): [Attach loss closes its session](https://github.com/ydb-platform/ydb/blob/8187ce049bed9e63a5ec04769da2d83dd237c08a/ydb/core/grpc_services/query/rpc_attach_session.cpp#L55-L94), [commit removes the transaction](https://github.com/ydb-platform/ydb/blob/8187ce049bed9e63a5ec04769da2d83dd237c08a/ydb/core/kqp/session_actor/kqp_session_actor.cpp#L2285-L2296), and [the RPC contract requires transaction-wide retry after an interrupted stream](https://github.com/ydb-platform/ydb/blob/8187ce049bed9e63a5ec04769da2d83dd237c08a/ydb/public/api/grpc/ydb_query_v1.proto#L26-L32). Error-injection tests use a controlled gRPC peer to schedule failures that a live database cannot reproduce deterministically; integration tests exercise public entry points against real YDB.

### Quick Start

```ts
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'

const driver = new Driver('grpc://localhost:2136/local')
await driver.ready()

const sql = query(driver)
const resultSets = await sql`SELECT 1 + 1 AS sum`
console.log(resultSets) // [ [ { sum: 2 } ] ]
```

### Parameterized Queries

```ts
const userId = 42n
const userName = 'Alice'
await sql`
  SELECT * FROM users
  WHERE id = ${userId} AND name = ${userName}
`
```

#### Named Parameters and Custom Types

```ts
import { Uint64 } from '@ydbjs/value/primitive'
const id = new Uint64(123n)
await sql`SELECT * FROM users WHERE id = $id`.parameter('id', id)
```

#### Arrays, Structs, and Table Parameters

```ts
const users = [
  { id: 1, name: 'Alice' },
  { id: 2, name: 'Bob' },
]
await sql`INSERT INTO users SELECT * FROM AS_TABLE(${users})`
```

### Transactions

```ts
// Serializable read-write transaction (default)
const result = await sql.begin(async (tx) => {
  await tx`UPDATE users SET active = false WHERE last_login < CurrentUtcTimestamp() - Interval('P1Y')`
  return await tx`SELECT * FROM users WHERE active = false`
})

// With isolation and idempotency options
await sql.begin({ isolation: 'snapshotReadOnly', idempotent: true }, async (tx) => {
  return await tx`SELECT COUNT(*) FROM users`
})
```

### Advanced: Multiple Result Sets, Streaming, and Events

```ts
import { StatsMode } from '@ydbjs/api/query'
// Multiple result sets
type Result = [{ id: number }, { count: number }]
const [rows, [{ count }]] =
  await sql<Result>`SELECT id FROM users; SELECT COUNT(*) as count FROM users;`

// Listen for query statistics and retries
const q = sql`SELECT * FROM users`.withStats(StatsMode.FULL)
q.on('stats', (stats) => console.log('Query stats:', stats))
q.on('retry', (ctx) => console.log('Retrying:', ctx))
await q
```

The `metadata` event receives a read-only metadata record from `@ydbjs/grpc`. Read a value with `metadata[key]`; repeated keys produce arrays, and binary values use `Uint8Array`.

### Error Handling

```ts
import { YDBError } from '@ydbjs/error'
try {
  await sql`SELECT * FROM non_existent_table`
} catch (e) {
  if (e instanceof YDBError) {
    console.error('YDB Error:', e.message)
  }
}
```

### Query Options and Chaining

```ts
import { StatsMode } from '@ydbjs/api/query'
await sql`SELECT * FROM users`
  .isolation('onlineReadOnly', { allowInconsistentReads: true })
  .idempotent(true)
  .timeout(5000)
  .withStats(StatsMode.FULL)
```

Inside a legacy `sql.begin()` / `sql.transaction()` callback, `isolation()` and `idempotent()` do not override the transaction options. A statement's `timeout()` still applies within the remaining outer budget, and `withStats()` still requests query statistics.

### Value Conversion and Type Safety

All parameter values are converted using `@ydbjs/value`. See its documentation for details on supported types and conversion rules. You can pass native JS types, or use explicit YDB value classes for full control.

```ts
import { fromJs } from '@ydbjs/value'
await sql`SELECT * FROM users WHERE meta = ${fromJs({ foo: 'bar' })}`
```

## Query Statistics

You can enable and access query execution statistics:

```ts
import { StatsMode } from '@ydbjs/api/query'
const q = sql`SELECT * FROM users`.withStats(StatsMode.FULL)
await q
console.log(q.stats())
```

## Identifiers and Unsafe Fragments

- Use identifiers for dynamic table/column names:

```ts
// As a method on the client
await sql`SELECT * FROM ${sql.identifier('users')}`

// Or import from the package if needed
import { identifier } from '@ydbjs/query'
await sql`SELECT * FROM ${identifier('users')}`
```

- Use unsafe only for trusted SQL fragments (never with user input):

```ts
import { unsafe } from '@ydbjs/query'
await sql`SELECT * FROM users ${unsafe('ORDER BY created_at DESC')}`
```

Security note: identifier() only quotes the name and escapes backticks. Do not pass untrusted input without validation/allow‑listing.

## Closing a client

`close()` stops accepting new query and transaction executions, waits for accepted work and its session cleanup, and releases the client's session pool. Queries and transactions already in progress may finish their retries and commit. `await using` calls `close()`.

```ts
let sql = query(driver)
let statement = sql`SELECT 1 AS id`.execute()
await sql.close()
let result = await statement
```

`destroy()` immediately cancels the client's pending queries, transactions and session work, clears its pool, and prevents further execution. `using` calls `destroy()`. It does not start rollback or DeleteSession RPCs; cancelling the attach streams leaves server cleanup to YDB. A running application callback receives an aborted signal; its own asynchronous work must observe that signal to stop.

```ts
using sql = query(driver)
let statement = sql`SELECT 1 AS id`
let result = statement.then(
  (rows) => rows,
  (error) => error
)
sql.destroy()
await result
```

Neither method closes the supplied `Driver`; other clients sharing it remain usable. To discard an individual query's retained parameters, results and listeners, call `statement.destroy()` or `await statement.dispose()`. Its `cancel()` method only cancels execution and emits the existing `cancel` event.

The session pool owns a single state machine for admission, session creation, leases, waiting callers and shutdown. Request handles have no state machine and do not allocate cancellation controllers until execution or explicit cancellation. Transaction outcomes and callback retry boundaries belong to the executor rather than the pool.

`poolOptions.maxSize` caps live and creating sessions. `waitQueueFactor` defaults to 8; at most `maxSize + ceil(maxSize * waitQueueFactor)` root operations can be admitted at once, including operations waiting for driver readiness or retry backoff. Additional calls reject with `SessionPoolFullError` instead of retaining an unbounded backlog.

## Observability via `node:diagnostics_channel`

`@ydbjs/query` publishes events on [`node:diagnostics_channel`](https://nodejs.org/api/diagnostics_channel.html) so external subscribers (`@ydbjs/telemetry`, OpenTelemetry, custom loggers) can build traces, metrics, and logs without coupling the SDK to a specific telemetry stack.

Every payload starts with a `driver: DriverIdentity` field (defined in `@ydbjs/core`) so multi-driver consumers can attribute events. Durations are in **milliseconds** (Node.js convention — `performance.now()` / `Date.now()`).

### Channels

#### Query execution

| Channel                         | Type    | Extra fields beyond `{ driver }`                                                               |
| ------------------------------- | ------- | ---------------------------------------------------------------------------------------------- |
| `tracing:ydb:query.execute`     | tracing | `{ text, sessionId, nodeId, idempotent, isolation }` — one `ExecuteQuery` RPC                  |
| `tracing:ydb:query.transaction` | tracing | `{ isolation, idempotent }` — from `tx.begin` to `commit`/`rollback`, including the retry loop |
| `tracing:ydb:query.begin`       | tracing | `{ sessionId, nodeId, isolation }` — one `BeginTransaction` RPC                                |
| `tracing:ydb:query.commit`      | tracing | `{ sessionId, nodeId, txId }` — one `CommitTransaction` RPC                                    |
| `tracing:ydb:query.rollback`    | tracing | `{ sessionId, nodeId, txId }` — one `RollbackTransaction` RPC                                  |

#### Session pool

| Channel                             | Type    | Extra fields beyond `{ driver }`                                            |
| ----------------------------------- | ------- | --------------------------------------------------------------------------- |
| `tracing:ydb:query.session.acquire` | tracing | _(none)_ — wraps each session-lease acquisition                             |
| `tracing:ydb:query.session.create`  | tracing | _(none)_ — wraps `CreateSession` RPC + first `AttachStream` message         |
| `tracing:ydb:query.session.delete`  | tracing | `{ sessionId, nodeId, reason, uptime }` — wraps `DeleteSession` cleanup     |
| `ydb:query.session.pool.opened`     | publish | `{ maxSize, minSize, maxWaiters }` — once per pool, config snapshot         |
| `ydb:query.session.pool.closed`     | publish | _(none)_                                                                    |
| `ydb:query.session.created`         | publish | `{ sessionId, nodeId }`                                                     |
| `ydb:query.session.closed`          | publish | `{ sessionId, nodeId, reason, uptime }` (ms) — see reasons below            |
| `ydb:query.session.acquired`        | publish | `{ sessionId, nodeId }` — lease handed to a caller                          |
| `ydb:query.session.released`        | publish | `{ sessionId, nodeId }` — caller dropped the lease (paired with `acquired`) |
| `ydb:query.session.acquire.failed`  | publish | `{ error }` — `acquire()` rejected (pool full, timeout, pool closed)        |
| `ydb:query.session.waiter.enqueued` | publish | _(none)_ — a caller started waiting because the pool is saturated           |
| `ydb:query.session.waiter.dequeued` | publish | _(none)_ — waiter resolved, rejected, or was aborted                        |

`reason` (`SessionCloseReason`) is one of: `'pool_close'` (pool tear-down), `'attach_failed'` (initial AttachStream rejected — session never lived), `'stream_closed'` (attach stream ended cleanly, e.g. server-side TTL), `'stream_error'` (attach stream errored mid-flight), or `'invalidated'` (the SDK retired a session after a fatal status or interrupted query). Invalidating a session closes Attach rather than issuing DeleteSession, so it emits `session.closed` without a `session.delete` RPC trace.

`pool.opened.minSize` reports the best-effort warm-up target. A failed background creation does not start an unbounded retry loop; queued operations continue to drive session creation within the pool limit.

### Retry hierarchy

Retry-loop spans (`tracing:ydb:retry.run`, `tracing:ydb:retry.attempt`, `ydb:retry.exhausted`) come from `@ydbjs/retry`. Session acquisition and statement execution belong to an attempt; `retryTransaction()` adds the outer `query.transaction` span. `AsyncLocalStorage` propagation preserves this ownership through streaming consumption:

```
ydb.query.transaction
└─ ydb.retry.run
   ├─ ydb.retry.attempt #1
   │  ├─ ydb.query.session.acquire
   │  ├─ ydb.query.begin
   │  ├─ ydb.query.execute   (SELECT ...)
   │  └─ ydb.query.commit            ← or ydb.query.rollback on body throw
   └─ ydb.retry.attempt #2
      ...
```

`query.begin` / `query.commit` / `query.rollback` each wrap exactly one server RPC. Use them for "begin/commit/rollback latency" and "rollback rate" metrics; `query.execute` is reserved for `ExecuteQuery` only. Rollback has a separate bounded cleanup budget. Caller cancellation can settle the public operation before cleanup finishes; graceful `close()` still waits for the accepted attempt's cleanup. Session deletion is awaited during graceful pool shutdown; cleanup after a failed initial Attach is best-effort background work. `destroy()` starts no cleanup RPCs.

### Subscribing

```ts
import { channel, tracingChannel } from 'node:diagnostics_channel'

tracingChannel('tracing:ydb:query.execute').subscribe({
  start(ctx) {
    span.start({
      name: 'ydb.query.execute',
      attributes: {
        'db.system.name': 'ydb',
        'db.namespace': ctx.driver.database,
        'db.query.text': ctx.text,
        'ydb.session.id': ctx.sessionId,
        'ydb.node.id': Number(ctx.nodeId),
        'ydb.isolation': ctx.isolation,
      },
    })
  },
  asyncEnd() {
    span.end()
  },
  error(ctx) {
    span.recordException(ctx.error)
    span.end()
  },
})

channel('ydb:query.session.closed').subscribe((msg) => {
  // msg.uptime is in ms; convert to seconds when feeding OTel histograms.
  metrics.sessionLifetime.record(msg.uptime / 1000, { reason: msg.reason })
})
```

### ⚠️ Subscribers must be safe

**`node:diagnostics_channel` invokes subscribers synchronously.** Any exception thrown inside a subscriber propagates up the call stack and **will** disrupt the SDK — a buggy subscriber can break a query mid-flight or leak a session lease. `@ydbjs/query` does **not** wrap your subscribers; wrap them yourself in `try/catch`.

### Stability

Channel names, payload field names, and the `reason` (`SessionCloseReason`) enum follow semantic versioning. Adding new optional fields or new enum values is a minor change; renaming or removing fields is a major change.

## Development

### Building the Package

```sh
npm run build
```

### Running Tests

```sh
npm test
```

## AI Assistant Configuration

This package includes example configuration files for AI assistants to generate secure YQL code in the `ai-instructions/` directory:

### Available Examples:

- `ai-instructions/.cursorrules.example` - Cursor AI (legacy format)
- `ai-instructions/.instructions.example.md` - General AI assistants
- `ai-instructions/.ai-instructions.example.md` - Alternative general format
- `ai-instructions/.copilot-instructions.example.md` - GitHub Copilot specific

Copy the appropriate file to your project root (remove `.example` suffix) to ensure AI-generated code follows YDB security best practices.

**Quick setup:**

```bash
# Choose the appropriate file for your AI assistant
cp node_modules/@ydbjs/query/ai-instructions/.cursorrules.example .cursorrules
cp node_modules/@ydbjs/query/ai-instructions/.instructions.example.md .instructions.md
```

See `SECURITY.md` for complete security guidelines.

## License

This project is licensed under the [Apache 2.0 License](../../LICENSE).

## Links

- [YDB Documentation](https://ydb.tech)
- [GitHub Repository](https://github.com/ydb-platform/ydb-js-sdk)
- [Issues](https://github.com/ydb-platform/ydb-js-sdk/issues)
