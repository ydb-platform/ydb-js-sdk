---
title: Drizzle Adapter — Database API
---

# Database API

The database object returned by `createDrizzle()` is the main runtime surface. It combines Drizzle-compatible query builders with YDB-specific helpers.

For a runnable app that exercises most methods on this page, see [Drizzle Adapter Examples](/guide/drizzle/examples).

## Initialization

The `createDrizzle` function (aliased as `drizzle`) is the entry point for creating a database instance.

### Configuration Methods

- `createDrizzle(options)` creates a database from a connection string or an existing client.
- `createDrizzle(callback, config?)` creates a database from a custom execution callback (useful for Remote/Proxy setups).

### Options

- `connectionString`: YDB connection string (e.g., `grpc://localhost:2136/local`). The adapter automatically creates and manages a `Driver` instance.
- `client`: existing `YdbExecutor` or `YdbTransactionalExecutor`.
- `schema`: table and relations object for typed Relational Query API (`db.query.*`).
- `logger`: `true` for default logger, `false` to disable, or a custom Drizzle `Logger`.
- `casing`: Drizzle casing mode (`'snake_case'` or `'camelCase'`) passed to the dialect.

Example:

```ts
import { createDrizzle } from '@ydbjs/drizzle-adapter'

let db = createDrizzle({
  connectionString: process.env['YDB_CONNECTION_STRING']!,
  schema,
  logger: true,
})
```

### Lifecycle Management

`db.$client` has the `YdbExecutor` interface, where `ready` and `close` are optional. With a connection string, the adapter owns the SDK driver and closes it through `$client.close()`. A `YdbDriver` wrapping an existing SDK driver leaves that driver open; the application closes it after all consumers finish.

Close an executor owned by your application when its work finishes:

```ts
try {
  await db.$client.ready?.()
  // Application queries.
} finally {
  await db.$client.close?.()
}
```

## Execution Methods

Methods for executing raw YQL or query builder objects:

| Method            | Description                                       |
| :---------------- | :------------------------------------------------ |
| `.execute(query)` | Executes a query and returns the typed result.    |
| `.all(query)`     | Returns all rows as an array of objects.          |
| `.get(query)`     | Returns the first row or `undefined`.             |
| `.values(query)`  | Returns rows as arrays of values in column order. |

Example:

```ts
import { sql } from 'drizzle-orm'

await db.execute(sql`DELETE FROM users WHERE id = ${1}`)

let rows = await db.all(sql`SELECT * FROM users`)
let first = await db.get(sql`SELECT * FROM users LIMIT 1`)
let values = await db.values<[number, string]>(sql`SELECT id, name FROM users`)

let firstBuilt = await db.get(db.select({ id: users.id, name: users.name }).from(users).limit(1))
```

## Query Builders

### SELECT Builders

- `db.select(fields?)`, `db.selectDistinct(fields?)`, `db.selectDistinctOn(on, fields?)`: create SELECT builders.
- `db.with(...queries)`, `db.$with(alias)`: create YDB CTE (Common Table Expressions) bindings.

### Mutation Builders

| Method                  | YQL Operation  | Description                      |
| :---------------------- | :------------- | :------------------------------- |
| `db.insert(table)`      | `INSERT INTO`  | Standard row insertion.          |
| `db.upsert(table)`      | `UPSERT INTO`  | Insert or update by Primary Key. |
| `db.replace(table)`     | `REPLACE INTO` | Full row replacement.            |
| `db.update(table)`      | `UPDATE`       | Partial update.                  |
| `db.delete(table)`      | `DELETE FROM`  | Row deletion.                    |
| `db.batchUpdate(table)` | (optimized)    | Mass update of multiple rows.    |
| `db.batchDelete(table)` | (optimized)    | Mass deletion of multiple rows.  |

### Utilities

- `db.$count(source, filters?)`: returns an awaitable count expression for efficient row counting.

```ts
import { eq } from 'drizzle-orm'

let activeCount = await db.$count(users, eq(users.active, true))

let rows = await db.select({ id: users.id, name: users.name }).from(users).limit(10).execute()
```

## Transactions

The `db.transaction()` method ensures atomicity for a group of operations.

```ts
await db.transaction(
  async (tx) => {
    await tx.insert(users).values({ id: 1, name: 'Alice' }).execute()
    await tx
      .update(stats)
      .set({ count: sql`count + 1` })
      .execute()

    // Manual rollback
    if (someCondition) {
      tx.rollback()
    }
  },
  {
    accessMode: 'read write',
    isolationLevel: 'serializableReadWrite',
  }
)
```

### Options

- `accessMode`: `'read write'` (default) or `'read only'`. Use `'read only'` for optimized read-heavy transactions.
- `isolationLevel`: `'serializableReadWrite'` (recommended for YDB) or `'snapshotReadOnly'`.
- `idempotent`: if `true`, permits retrying the entire callback for retryable failures; all work in the callback must be safe to repeat.

## Relational Query API

Typed relations are enabled by passing a `schema` during initialization. Use `db.query.*` for declarative data fetching without manual JOINs.

```ts
let user = await db.query.users.findFirst({
  where: (u, { eq }) => {
    return eq(u.id, 1)
  },
  with: {
    posts: {
      columns: {
        id: true,
        title: true,
      },
      limit: 5,
      orderBy: (p, { desc }) => {
        return [desc(p.id)]
      },
    },
    profile: true,
  },
})
```

### Options

- `columns`: include or exclude specific table columns.
- `where`: filter logic using table columns and Drizzle operators.
- `orderBy`: sort expressions.
- `limit`, `offset`: pagination controls.
- `with`: nested relation loading.
- `extras`: additional SQL expressions.
