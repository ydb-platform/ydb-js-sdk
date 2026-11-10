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
- Pass a shared `QueryClient` from `@ydbjs/query` or a custom `YdbExecutor` or `YdbTransactionalExecutor` as `client`.
- `schema`: table and relations object for typed Relational Query API (`db.query.*`).
- `logger`: `true` for default logger, `false` to disable, or a custom Drizzle `Logger`.
- `casing`: Drizzle casing mode (`'snake_case'` or `'camelCase'`) passed to the dialect.

Example:

```ts
import { createDrizzle } from '@ydbjs/drizzle-adapter'

const db = createDrizzle({
  connectionString: process.env['YDB_CONNECTION_STRING']!,
  schema,
  logger: true,
})
```

### Lifecycle Management

A connection string gives the adapter ownership of both the driver and the session pool. `new YdbDriver(driver)` owns only the pool. Call `db.$client.close?.()` to release adapter-owned resources. The owner of a shared `QueryClient` closes it.

```ts
await db.$client.ready?.()

// ... application logic ...

db.$client.close?.()
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

const rows = await db.all(sql`SELECT * FROM users`)
const first = await db.get(sql`SELECT * FROM users LIMIT 1`)
const values = await db.values<[number, string]>(sql`SELECT id, name FROM users`)

const firstBuilt = await db.get(db.select({ id: users.id, name: users.name }).from(users).limit(1))
```

In a Drizzle SQL template, `${null}` renders as the YQL constant `NULL`. For prebuilt SQL with a bare null in the positional parameter list, use an explicit declaration.

```ts
await db.execute({
  sql: 'DECLARE $p0 AS Null; SELECT $p0 AS value',
  params: [null],
})
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

const activeCount = await db.$count(users, eq(users.active, true))

const rows = await db.select({ id: users.id, name: users.name }).from(users).limit(10).execute()
```

## Transactions

Statements issued through `tx` and through the same `db` inside `db.transaction()` participate in one transaction. On a conflict such as `ABORTED`, the SDK may rerun the entire callback. Keep external side effects such as charging a payment outside the callback.

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
- `idempotent` defaults to `false`, including for read-only transactions. Set it to `true` only if replaying the whole callback is safe when the previous outcome is unknown.

## Relational Query API

Typed relations are enabled by passing a `schema` during initialization. Use `db.query.*` for declarative data fetching without manual JOINs.

```ts
const user = await db.query.users.findFirst({
  where: (u, { eq }) => eq(u.id, 1),
  with: {
    posts: {
      columns: {
        id: true,
        title: true,
      },
      limit: 5,
      orderBy: (p, { desc }) => [desc(p.id)],
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
