---
title: Query — Overview
---

# Query `@ydbjs/query`

High-level, type-safe client for YQL queries and transactions.

This is the high-level overview of the `@ydbjs/query` client. For details, continue with:

- [Options & API](/guide/query/options)
- [Examples](#examples)
- [Types & Values](/guide/query/value)

## Quick Start

```ts
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'

using driver = new Driver('grpc://localhost:2136/local')
await driver.ready()

await using sql = query(driver)
let [rows] = await sql`SELECT 1 + 1 AS sum`
console.log(rows)
```

## Examples {#examples}

### Parameters and AS_TABLE {#examples-parameters}

```ts
let users = [
  { id: 1, name: 'Alice' },
  { id: 2, name: 'Bob' },
]
await sql`INSERT INTO users SELECT * FROM AS_TABLE(${users})`
```

### Named parameters {#examples-named-parameters}

Pass a JavaScript value by name; the SDK infers its YDB type. In V7, the SQL tag no longer generates `DECLARE` statements. Add a declaration when required by your database or parameter type.

```ts
let id = 42

await sql`SELECT $id AS id`.parameter('id', id)
```

### Collecting stats {#examples-stats}

```ts
import { StatsMode } from '@ydbjs/api/query'

let q = sql`SELECT * FROM users`.withStats(StatsMode.FULL)

q.on('stats', (s) => {
  console.log('Stats:', s)
})

await q
```

### Result formats {#examples-results}

```ts
// Array of values (column order)
let vals = await sql`SELECT 1 AS a, 2 AS b`.values()
console.log(vals) // [[[1, 2]]]

// Raw protobuf Ydb.Value cells, without their column types
let raw = await sql`SELECT 1`.raw()
```

### Per-call isolation {#examples-isolation}

```ts
await sql`SELECT * FROM users`.isolation('snapshotReadOnly').timeout(3000)
```

### Error handling {#examples-errors}

```ts
import { YDBError } from '@ydbjs/error'

try {
  await sql`SELECT * FROM non_existent`
} catch (e) {
  if (e instanceof YDBError) {
    console.error('YDB error code:', e.code)
  }
}
```

### Dynamic identifiers and unsafe fragments {#examples-identifiers}

```ts
// Safe dynamic table/column names
let table = sql.identifier('users')
let column = sql.identifier('created_at')
let rows = await sql`SELECT ${column} FROM ${table} WHERE id = ${42}`

// Unsafe fragments for trusted code only (migrations, DDL)
await sql`PRAGMA TablePathPrefix(${sql.unsafe("'/Root/dev'")});`
```

### Query events and retries {#examples-events}

```ts
import { StatsMode } from '@ydbjs/api/query'

let q = sql`SELECT * FROM heavy_table`.idempotent(true).withStats(StatsMode.FULL)

q.on('retry', (ctx) => {
  console.log('retry attempt', ctx.attempt, ctx.error)
})

q.on('stats', (s) => {
  console.log('cpu(us)=', s.totalCpuTimeUs)
})

await q
```

### Cancellation and timeouts {#examples-cancel}

```ts
let signal = AbortSignal.timeout(1000)

await sql`SELECT COUNT(*) FROM users`.signal(signal)
```

### Isolation modes {#examples-isolation-modes}

```ts
// Snapshot read-only single-call transaction
await sql`SELECT COUNT(*) FROM users`.isolation('snapshotReadOnly')

// Online read-only with inconsistent reads allowed
await sql`SELECT COUNT(*) FROM users`.isolation('onlineReadOnly', {
  allowInconsistentReads: true,
})
```

### Syntax and pool {#examples-syntax-pool}

```ts
import { Syntax } from '@ydbjs/api/query'

await sql`SELECT 1`.syntax(Syntax.YQL_V1)
await sql`SELECT 1`.pool('analytics')
```

### Transaction hooks {#examples-tx-hooks}

```ts
let result = await sql.begin(async (tx, signal) => {
  tx.onCommit(() => {
    console.log('committing tx', tx.transactionId)
  })

  tx.onRollback((err) => {
    console.log('rolling back tx', err)
  })

  await tx`UPSERT INTO audit(id, ts) VALUES (${1}, CurrentUtcDatetime())`
  return await tx`SELECT * FROM audit WHERE id = ${1}`
})
```
