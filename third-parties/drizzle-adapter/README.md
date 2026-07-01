# @ydbjs/drizzle-adapter

[![codecov](https://codecov.io/gh/ydb-platform/ydb-js-sdk/graph/badge.svg?component=drizzle-adapter)](https://codecov.io/gh/ydb-platform/ydb-js-sdk)

The `@ydbjs/drizzle-adapter` package wires [Drizzle ORM](https://orm.drizzle.team/) to YDB. It ships typed schema declarations with YDB-native column types, query builders that emit valid YQL, a relational `db.query.*` API, a migration runner with history and optional distributed locking, and ergonomic wrappers around YDB built-in functions and UDFs (Digest hashes, `CurrentUtc*`, `Knn::*`, set operators, pragmas, scripts).

## Features

- YDB column helpers with primary keys, unique constraints, secondary and vector indexes, table options, TTL, and column families
- SELECT builders with joins, CTEs, set operators, `WITHOUT`, `FLATTEN`, `SAMPLE`, `TABLESAMPLE`, `MATCH_RECOGNIZE`, windows, and YDB optimizer hints
- Mutation builders for `insert`, `upsert`, `replace`, `update`, `batchUpdate`, `delete`, `batchDelete`
- `db.query.*` relational queries through Drizzle relation metadata
- Direct YQL via `db.execute(sql\`...\`)`and`db.values(...)`
- `migrate()` with bookkeeping table, optional lock table, and recovery strategy
- Typed YQL helpers: `numericHash` / `xxHash` / `crc32c` / `crc64`, `currentUtc*`, `random` / `randomNumber` / `randomUuid` with required per-row cache keys, `unwrap`, `maxOf` / `minOf`, `knnCosineDistance` and the rest of the `Knn::*` family
- YDB-typed errors (`YdbUniqueConstraintViolationError`, `YdbAuthenticationError`, etc.) wrapping Drizzle's `DrizzleQueryError`
- Full TypeScript support, ESM-only

## Installation

```sh
npm install @ydbjs/drizzle-adapter drizzle-orm
```

Requires Node.js 20.19+ and `drizzle-orm@^0.45.2`.

## How It Works

- **Subpath entries**: the package exposes four entries instead of one mega-barrel:

  | Subpath                           | What it owns                                                                                                                       |
  | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
  | `@ydbjs/drizzle-adapter`          | `createDrizzle`, `drizzle`, `YdbDriver`, error classes, `relations`/`many`/`one` re-exported from drizzle-orm                      |
  | `@ydbjs/drizzle-adapter/schema`   | `ydbTable`, column types, `primaryKey`, `unique`, indexes, table options                                                           |
  | `@ydbjs/drizzle-adapter/sql`      | YQL expression helpers (hash UDFs, `currentUtc*`, `random*`, `unwrap`, `maxOf`/`minOf`, `Knn::*`, set operators, pragmas, scripts) |
  | `@ydbjs/drizzle-adapter/migrator` | `migrate()` plus `build*Sql` DDL builders and migration types                                                                      |

- **Driver ownership**: `createDrizzle({ connectionString })` owns the driver and closes it with `db.$client.close?.()`. Pass `{ driver }` to share an existing `YdbDriver` with other YDB clients.
- **Query execution**: all builders go through `YdbSession`, which uses the same driver/pool as `@ydbjs/query` under the hood.
- **Migrations**: `migrate()` records every applied migration in a YDB table; with `migrationLock` enabled, parallel deploy jobs coordinate through a lock table instead of racing.

## Usage

### Quick Start

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

The leading `hash` column is YDB's recommended way to spread writes across tablets. `numericHash(id)` emits `Unwrap(Digest::NumericHash(CAST(id AS Uint64)))` so the cluster computes the shard prefix at insert time; `xxHash(value)` does the same for string keys.

### Schema and Composite Primary Keys

```ts
import { integer, primaryKey, text, uint64, ydbTable } from '@ydbjs/drizzle-adapter/schema'
import { xxHash } from '@ydbjs/drizzle-adapter/sql'

let articles = ydbTable(
  'articles',
  {
    hash: uint64('hash').notNull(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
  },
  (t) => [primaryKey(t.hash, t.slug)]
)

await db.insert(articles).values({
  hash: xxHash('intro'),
  slug: 'intro',
  title: 'Hello, YDB',
})
```

### Transactions

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

Transactions are not nestable through the adapter — open one boundary at the top of the unit of work and pass `tx` down. Supported isolations are `serializableReadWrite` and `snapshotReadOnly` (`snapshotReadOnly` is read-only by definition; the adapter rejects mutations under it).

#### When to use `idempotent: true`

`idempotent: true` opts the transaction into the `@ydbjs/retry` policy: on a retryable YDB failure the **entire callback re-runs from scratch**, not just the failed statement. Set it only when re-running the whole callback is safe.

```ts
// Safe — only YDB mutations inside the callback
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
// UNSAFE — the Stripe charge will fire twice on retry
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
  { idempotent: true } // ← don't do this
)
```

When in doubt, leave `idempotent` unset and handle the retryable error in your own code.

### YQL Helpers

```ts
import { sql } from 'drizzle-orm'
import {
  currentUtcTimestamp,
  knnCosineDistance,
  maxOf,
  numericHash,
  randomUuid,
  xxHash,
} from '@ydbjs/drizzle-adapter/sql'
import { vectorIndexView } from '@ydbjs/drizzle-adapter/schema'

await db
  .insert(events)
  .values({
    hash: numericHash(eventId),
    id: eventId,
    traceId: randomUuid(events.id),
    createdAt: currentUtcTimestamp(),
  })
  .execute()

let similar = await db
  .select({
    id: docs.id,
    distance: knnCosineDistance(docs.embedding, sql`$target`),
  })
  .from(docs)
  .view(vectorIndexView(docs, 'docs_emb_idx'))
  .orderBy(sql`distance ASC`)
  .limit(10)
```

`random*` helpers require at least one cache key — without it YDB returns the same value for every row. Pass any column reference or expression that varies per row.

### Migrations

```ts
import { migrate } from '@ydbjs/drizzle-adapter/migrator'

await migrate(db, {
  migrationsFolder: './drizzle',
  migrationLock: {
    key: 'production',
    leaseMs: 10 * 60 * 1000,
    acquireTimeoutMs: 60 * 1000,
  },
  migrationRecovery: {
    mode: 'retry',
    staleRunningAfterMs: 60 * 60 * 1000,
  },
})
```

`migrate()` also accepts an inline `migrations: [...]` array (no folder) for programmatic schemas. DDL builders such as `buildCreateTableSql`, `buildAlterTableSql`, and `buildAddIndexSql` are exported from the same entry for tooling that needs to render statements without running them.

## Type Mapping

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

## Error Handling

Failures are wrapped in Drizzle's `DrizzleQueryError` with YDB-specific subclasses when the status maps cleanly:

- `YdbUniqueConstraintViolationError`
- `YdbAuthenticationError`
- `YdbCancelledQueryError`
- `YdbTimeoutQueryError`
- `YdbUnavailableQueryError`
- `YdbOverloadedQueryError`
- `YdbRetryableQueryError`

Mapped errors carry non-enumerable `kind`, `retryable`, `statusCode`, and the original YDB diagnostic fields (`code`, `status`, `issues`) when present.

## Limitations

- ESM-only; Node.js 20.19+; no CommonJS build
- Transactions are not nestable through the adapter — use one boundary per unit of work
- `references()` is metadata for Drizzle relations; YDB does not enforce foreign keys
- Unique indexes must be created with `CREATE TABLE`; adding one to an existing table is rejected by the DDL builder
- `replace()` is a full-row replacement by primary key — use `upsert()` or `update()` for partial changes
- `sql.raw()`, inline migration `sql`, `rawTableOption()`, view query text, ACL raw permissions, and transfer `using` text intentionally trust caller-provided YQL

## Development

```sh
npm run build --workspace=@ydbjs/drizzle-adapter
npm run test:unit --workspace=@ydbjs/drizzle-adapter
npm run test:int --workspace=@ydbjs/drizzle-adapter   # requires Docker for ydbplatform/local-ydb
npm run attw --workspace=@ydbjs/drizzle-adapter
npm run check:surface --workspace=@ydbjs/drizzle-adapter
```

The root CI workflow runs the same suite against a Docker-backed YDB on every pull request.

## License

This project is licensed under the [Apache 2.0 License](../../LICENSE).

## Links

- [YDB Documentation](https://ydb.tech)
- [Drizzle ORM](https://orm.drizzle.team/)
- [GitHub Repository](https://github.com/ydb-platform/ydb-js-sdk)
- [Issues](https://github.com/ydb-platform/ydb-js-sdk/issues)
