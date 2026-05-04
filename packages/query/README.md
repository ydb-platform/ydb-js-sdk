# @ydbjs/query

Read this in Russian: [README.ru.md](README.ru.md)

The `@ydbjs/query` package provides a high-level, type-safe client for executing YQL queries and managing transactions in YDB. It features a tagged template API, automatic parameter binding, transaction helpers, and deep integration with the YDB type system.

## Features

- Tagged template syntax for YQL queries
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

- **Query Client**: Create a query client with `query(driver)`. This provides a tagged template function for YQL queries and helpers for transactions.
- **Session Pool**: Sessions are automatically pooled and reused between queries and transactions (default pool size: 50). Configure with `query(driver, { poolOptions: { maxSize: 100 } })`.
- **Sessions & Transactions**: Sessions and transactions are managed automatically. You can run single queries or group multiple queries in a transaction with `begin`/`transaction`.
- **Parameter Binding**: Parameters are bound by interpolation (`${}`) in the template string. Native JS types, YDB value classes, and arrays/objects are all supported. Use `.parameter()`/`.param()` for named parameters.
- **Type Safety**: All values are converted using `@ydbjs/value` (see its docs for details). Complex/nested types and arrays are handled automatically.
- **Result Sets**: Most queries return an array of result sets (YDB supports multiple result sets per query).
- **Query Statistics**: Use `.withStats()` or `.stats()` to access execution statistics.

## Usage

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
type Result = [[{ id: number }], [{ count: number }]]
const [rows, [{ count }]] =
  await sql<Result>`SELECT id FROM users; SELECT COUNT(*) as count FROM users;`

// Listen for query statistics and retries
const q = sql`SELECT * FROM users`.withStats(StatsMode.FULL)
q.on('stats', (stats) => console.log('Query stats:', stats))
q.on('retry', (ctx) => console.log('Retrying:', ctx))
await q
```

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

Note: isolation(), idempotent(), timeout(), and withStats() apply to single execute calls only; they are ignored inside transactions (sql.begin/sql.transaction).

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

## Observability via `node:diagnostics_channel`

`@ydbjs/query` publishes events on [`node:diagnostics_channel`](https://nodejs.org/api/diagnostics_channel.html) so external subscribers (`@ydbjs/telemetry`, OpenTelemetry, custom loggers) can build traces, metrics, and logs without coupling the SDK to a specific telemetry stack.

### Channels

#### Query execution

| Channel                         | Type    | Payload                                                                                        |
| ------------------------------- | ------- | ---------------------------------------------------------------------------------------------- |
| `tracing:ydb:query.execute`     | tracing | `{ text, sessionId, nodeId, idempotent, isolation, stage }` — one `ExecuteQuery` RPC           |
| `tracing:ydb:query.transaction` | tracing | `{ isolation, idempotent }` — from `tx.begin` to `commit`/`rollback`, including the retry loop |
| `tracing:ydb:query.begin`       | tracing | `{ sessionId, nodeId, isolation }` — one `BeginTransaction` RPC                                |
| `tracing:ydb:query.commit`      | tracing | `{ sessionId, nodeId, txId }` — one `CommitTransaction` RPC                                    |
| `tracing:ydb:query.rollback`    | tracing | `{ sessionId, nodeId, txId }` — one `RollbackTransaction` RPC (fire-and-forget)                |

`stage` is `'standalone'` for single-shot queries, `'tx'` for queries inside a transaction body, and `'do'` reserved for the future `sql.do(...)` runner.

#### Session pool

| Channel                       | Type    | Payload                                                            |
| ----------------------------- | ------- | ------------------------------------------------------------------ |
| `tracing:ydb:session.acquire` | tracing | `{ kind: 'query' \| 'transaction' }`                               |
| `tracing:ydb:session.create`  | tracing | `{ liveSessions, maxSize, creating }` — only when the pool grows   |
| `ydb:session.created`         | publish | `{ sessionId, nodeId }`                                            |
| `ydb:session.closed`          | publish | `{ sessionId, nodeId, reason: 'evicted' \| 'pool_close', uptime }` |

`session.closed` fires **once** per session lifecycle. `reason` distinguishes server-side teardown (`evicted` — attach stream died, e.g. session expired or was dropped by the server) from explicit pool shutdown (`pool_close` — emitted for every session still tracked by the pool when `pool.close()` runs).

### Retry hierarchy

Retry-loop spans (`tracing:ydb:retry.run`, `tracing:ydb:retry.attempt`, `ydb:retry.exhausted`) come from `@ydbjs/retry` and nest correctly under `query.transaction` / `query.execute` via `AsyncLocalStorage` propagation in `tracePromise`. Subscribers see a tree like:

```
ydb.query.transaction
└─ ydb.retry.run
   ├─ ydb.retry.attempt #1
   │  ├─ ydb.session.acquire
   │  ├─ ydb.query.begin
   │  ├─ ydb.query.execute   (SELECT ...)
   │  └─ ydb.query.commit            ← or ydb.query.rollback on body throw
   └─ ydb.retry.attempt #2
      ...
```

`query.begin` / `query.commit` / `query.rollback` each wrap exactly one server RPC. Use them for "begin/commit/rollback latency" and "rollback rate" metrics; `query.execute` is reserved for `ExecuteQuery` only. Rollback is fire-and-forget — its `start` always fires, but `asyncEnd` may land after the surrounding `query.transaction.error`.

### Subscribing

```ts
import { channel, tracingChannel } from 'node:diagnostics_channel'

tracingChannel('tracing:ydb:query.execute').subscribe({
  start(ctx) {
    span.start({
      name: 'ydb.query.execute',
      attributes: {
        'db.system': 'ydb',
        'db.statement': ctx.text,
        'db.ydb.session_id': ctx.sessionId,
        'db.ydb.node_id': String(ctx.nodeId),
        'db.ydb.isolation': ctx.isolation,
        'db.ydb.stage': ctx.stage,
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

channel('ydb:session.closed').subscribe((msg) => {
  metrics.sessionLifetime.record(msg.uptime, { reason: msg.reason })
})
```

### ⚠️ Subscribers must be safe

**`node:diagnostics_channel` invokes subscribers synchronously.** Any exception thrown inside a subscriber propagates up the call stack and **will** disrupt the SDK — a buggy subscriber can break a query mid-flight or leak a session lease. `@ydbjs/query` does **not** wrap your subscribers; wrap them yourself in `try/catch`.

### Stability

Channel names, payload field names, and the `stage` / `reason` / `kind` enums follow semantic versioning. Adding new optional fields or new enum values is a minor change; renaming or removing fields is a major change.

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
