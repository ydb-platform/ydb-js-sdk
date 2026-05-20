---
title: Drizzle — Overview
---

# Drizzle (@ydbjs/drizzle-adapter)

YDB adapter for [Drizzle ORM](https://orm.drizzle.team/). Gives you typed
schemas, query builders that emit valid YQL, direct-execute escape hatches, a
migration runner, and ergonomic wrappers around YDB-specific UDFs and
built-ins.

Pick this adapter when:

- You want one codebase that talks to YDB through both a typed query builder
  and raw YQL when needed.
- You need migrations with history and an optional distributed lock.
- You like the Drizzle DX (table objects, `db.query.*` relations, prepared
  queries) but want to keep YDB's native types, vector search, and shard-key
  patterns first-class.

If your workload is exclusively dynamic YQL with parameterised templates,
`@ydbjs/query` is the lighter choice. The adapter is built on the same driver.

## Install

```sh
npm install @ydbjs/drizzle-adapter drizzle-orm
```

ESM-only, Node.js 20.19+, peer-depends on `drizzle-orm@^0.45.2`.

## Entry points

```ts
import { createDrizzle, YdbDriver } from '@ydbjs/drizzle-adapter'
import { ydbTable, integer, text, primaryKey } from '@ydbjs/drizzle-adapter/schema'
import { numericHash, currentUtcTimestamp } from '@ydbjs/drizzle-adapter/sql'
import { migrate, buildCreateTableSql } from '@ydbjs/drizzle-adapter/migrator'
```

| Subpath     | Surface                                                          |
| ----------- | ---------------------------------------------------------------- |
| `.`         | Bootstrap: connect, error classes, relations re-export           |
| `/schema`   | `ydbTable`, columns, constraints, indexes, table options         |
| `/sql`      | YQL expression helpers (UDFs, built-ins, set operators, pragmas) |
| `/migrator` | `migrate()` + `build*Sql` DDL builders + migration types         |

See [Schema](./schema), [SQL helpers](./sql), and [Migrations](./migrator) for
each surface in detail.

## Quick start

```ts
import { eq } from 'drizzle-orm'
import { createDrizzle } from '@ydbjs/drizzle-adapter'
import {
  integer,
  primaryKey,
  text,
  timestamp,
  uint64,
  ydbTable,
} from '@ydbjs/drizzle-adapter/schema'
import { currentUtcTimestamp, numericHash } from '@ydbjs/drizzle-adapter/sql'

let users = ydbTable(
  'users',
  {
    hash: uint64('hash').notNull(),
    id: integer('id').notNull(),
    email: text('email').notNull(),
    createdAt: timestamp('created_at').notNull(),
  },
  (t) => [primaryKey(t.hash, t.id)]
)

let db = createDrizzle({
  connectionString: process.env['YDB_CONNECTION_STRING']!,
  schema: { users },
})

await db
  .insert(users)
  .values({
    hash: numericHash(1),
    id: 1,
    email: 'ada@example.com',
    createdAt: currentUtcTimestamp(),
  })
  .execute()

let row = await db
  .select({ id: users.id, email: users.email })
  .from(users)
  .where(eq(users.id, 1))
  .prepare()
  .get()

await db.$client.close?.()
```

The leading `hash` column is the canonical YDB pattern for distributing writes
across tablets. See [Schema → shard-prefix primary keys](./schema#shard-prefix-primary-keys).

## Connecting

`createDrizzle()` accepts the same shapes as `drizzle()` from upstream
drizzle-orm but always wraps a `YdbDriver`:

```ts
// Connection string
let db = createDrizzle({
  connectionString: 'grpcs://ydb.example.com:2135/your-db',
  schema: { users },
})

// Pre-built driver (lets you share one driver across query and topic clients)
import { YdbDriver } from '@ydbjs/drizzle-adapter'
let driver = new YdbDriver({ connectionString: process.env.YDB_CONNECTION_STRING! })
let db = createDrizzle({ driver, schema: { users } })

// Callback executor for testing — receives ({ sql, params, method, options })
let db = createDrizzle(async (query, params, method, options) => {
  return realExecutor(query, params, method, options)
})
```

The driver is owned by the database when you pass a connection string; pass a
pre-built `YdbDriver` if you want to share it with other YDB clients (the
driver isn't closed when you `db.$client.close?.()`).

## Transactions

```ts
await db.transaction(
  async (tx) => {
    await tx
      .insert(users)
      .values({
        /* ... */
      })
      .execute()
    await tx
      .update(users)
      .set({
        /* ... */
      })
      .where(/* ... */)
      .execute()
  },
  { isolationLevel: 'serializableReadWrite' }
)
```

Pass `tx` down to functions that need to participate. Transactions are not
nestable through the adapter — open one boundary at the top of the unit of
work. Supported isolations are `serializableReadWrite` and
`snapshotReadOnly` (`snapshotReadOnly` is read-only by definition; the
adapter rejects mutations under it).

### When to use `idempotent: true`

`idempotent: true` opts the transaction into the `@ydbjs/retry` policy: on a
retryable YDB failure the **entire callback re-runs from scratch**, not just
the failed statement. Set it only when re-running the whole callback is safe.

```ts
// ✅ Safe — only YDB mutations inside the callback
await db.transaction(
  async (tx) => {
    await tx
      .insert(events)
      .values({
        /* ... */
      })
      .execute()
  },
  { isolationLevel: 'serializableReadWrite', idempotent: true }
)
```

```ts
// ❌ UNSAFE — the Stripe charge will fire twice on retry
await db.transaction(
  async (tx) => {
    await stripe.charges.create({
      /* ... */
    }) // external side effect!
    await tx
      .insert(payments)
      .values({
        /* ... */
      })
      .execute()
  },
  { idempotent: true }
)
```

When in doubt, leave `idempotent` unset and decide how to react to a
retryable error in your own code. The flag is a contract about the _callback
body_, not about the SQL inside it.

## Error handling

Execution failures are wrapped in Drizzle's `DrizzleQueryError` with
YDB-specific subclasses when the status maps cleanly:

| Class                               | When                                  |
| ----------------------------------- | ------------------------------------- |
| `YdbUniqueConstraintViolationError` | Primary key or unique index conflict  |
| `YdbAuthenticationError`            | Auth failure                          |
| `YdbCancelledQueryError`            | Query cancelled by client or server   |
| `YdbTimeoutQueryError`              | Server-side timeout                   |
| `YdbUnavailableQueryError`          | Cluster could not route the request   |
| `YdbOverloadedQueryError`           | Tablet overloaded                     |
| `YdbRetryableQueryError`            | Status hints that a retry may succeed |

All mapped errors carry non-enumerable `kind`, `retryable`, `statusCode`, plus
the original YDB diagnostic fields (`code`, `status`, `issues`) when present.

```ts
import { YdbUniqueConstraintViolationError } from '@ydbjs/drizzle-adapter'

try {
  await db
    .insert(users)
    .values({
      /* ... */
    })
    .execute()
} catch (error) {
  if (error instanceof YdbUniqueConstraintViolationError) {
    // dedupe path
  } else {
    throw error
  }
}
```

## Type mapping

| YDB family                                            | JavaScript / TypeScript value |
| ----------------------------------------------------- | ----------------------------- |
| `Bool`                                                | `boolean`                     |
| `Int8`..`Int32`, `Uint8`..`Uint32`, `Float`, `Double` | `number`                      |
| `Int64`, `Uint64`                                     | `bigint`                      |
| `Utf8`, `Uuid`                                        | `string`                      |
| `String`, `Yson`                                      | `Uint8Array`                  |
| `Date`, `Datetime`, `Timestamp` and 64-bit variants   | `Date`                        |
| `Json`, `JsonDocument`                                | typed JSON value              |

Use `bytes()` for binary `String`, `text()` for `Utf8`.

## Limitations

- ESM-only, Node.js 20.19+, no CommonJS build.
- `references()` is metadata for Drizzle relations; YDB does not enforce foreign keys.
- Unique indexes must be created with `CREATE TABLE`; adding one to an existing table is rejected by the DDL builder.
- `replace()` is a full-row replacement by primary key — use `upsert()` or `update()` for partial changes.
- `sql.raw()`, inline migration `sql`, `rawTableOption()`, view query text, ACL raw permissions, and transfer `using` text intentionally trust caller-provided YQL.
