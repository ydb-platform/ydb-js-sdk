# @ydbjs/drizzle-adapter

YDB adapter for Drizzle ORM. The package provides typed schema declarations, YDB-aware query builders, direct YQL execution helpers, DDL helpers, and a migration runner with history and optional locking.

## Install

```sh
npm install @ydbjs/drizzle-adapter drizzle-orm
```

Requires Node.js 20.19 or newer.

## Quick Start

```ts
import { eq } from 'drizzle-orm'
import { createDrizzle, integer, text, timestamp, ydbTable } from '@ydbjs/drizzle-adapter'

export let users = ydbTable('users', {
  id: integer('id').primaryKey(),
  email: text('email').notNull(),
  createdAt: timestamp('created_at').notNull(),
})

let db = createDrizzle({
  connectionString: process.env['YDB_CONNECTION_STRING']!,
  schema: { users },
})

await db
  .insert(users)
  .values({
    id: 1,
    email: 'ada@example.com',
    createdAt: new Date(),
  })
  .execute()

await db
  .upsert(users)
  .values({
    id: 1,
    email: 'ada@new.example.com',
    createdAt: new Date(),
  })
  .execute()

let row = await db
  .select({ id: users.id, email: users.email })
  .from(users)
  .where(eq(users.id, 1))
  .prepare()
  .get()

db.$client.close?.()
```

## Main Capabilities

- Schema declarations with YDB column helpers, primary keys, unique constraints, secondary and vector indexes, table options, TTL, and column families.
- SELECT builders with joins, CTEs, set operators, `WITHOUT`, `FLATTEN`, `SAMPLE`, `TABLESAMPLE`, `MATCH_RECOGNIZE`, window helpers, and YDB optimizer hints.
- Mutation helpers for `insert`, `upsert`, `replace`, `update`, `batchUpdate`, `delete`, and `batchDelete`.
- `db.query.*` relations API using Drizzle relation metadata.
- `YdbDriver`, prepared queries, raw YQL helpers, and transaction support through the database object.
- DDL helpers and `migrate()` with migration history, lock table, and recovery options.
- Typed YDB query errors for unique constraints, authentication, cancellation, timeouts, unavailable/overloaded services, and retryable failures.

## Type Mapping Notes

Most scalar YDB values map directly to JavaScript primitives:

| YDB family                                            | JavaScript / TypeScript value |
| ----------------------------------------------------- | ----------------------------- |
| `Bool`                                                | `boolean`                     |
| `Int8`..`Int32`, `Uint8`..`Uint32`, `Float`, `Double` | `number`                      |
| `Int64`, `Uint64`                                     | `bigint`                      |
| `Utf8`, `Uuid`                                        | `string`                      |
| `String`, `Yson`                                      | `Uint8Array`                  |
| `Date`, `Datetime`, `Timestamp` and 64-bit variants   | `Date`                        |
| `Json`, `JsonDocument`                                | typed JSON value              |

Use `bytes()` for binary YDB `String`; use `text()` for human-readable UTF-8 text.

## Migrations In CI/CD

Run migrations as a single deployment step before application instances start serving traffic. Enable the YDB lock table so parallel deploy jobs do not apply the same migration concurrently.

```ts
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

In CI, run the live test project against a real YDB service:

```sh
npm run build -- --filter=@ydbjs/drizzle-adapter
npm run attw -- --filter=@ydbjs/drizzle-adapter
npm run test:live --workspace=@ydbjs/drizzle-adapter
```

## Limitations

- The package follows the SDK runtime baseline: ESM-only, Node.js 20.19+, and no CommonJS build.
- YDB transactions are not nestable through the adapter. Use one `db.transaction()` boundary and pass `tx` down.
- Supported isolation options are YDB `serializableReadWrite` and `snapshotReadOnly`.
- `references()` metadata is for Drizzle relations. YDB does not enforce native foreign keys.
- Unique indexes must be created with `CREATE TABLE`; adding a unique index to an existing table is rejected by the DDL builder.
- `replace()` is a full-row replacement by primary key. Prefer `upsert()` or `update()` for partial changes.
- Query builders and DDL helpers escape identifiers and bind values. Raw surfaces such as `sql.raw()`, inline migration `sql`, `rawTableOption()`, view query text, ACL raw permissions, and transfer `using` text intentionally trust caller-provided YQL.

## Development Checks

From the SDK repository root:

```sh
npm run build -- --filter=@ydbjs/drizzle-adapter
npm run attw -- --filter=@ydbjs/drizzle-adapter
npm run check:surface --workspace=@ydbjs/drizzle-adapter
npm run test --workspace=@ydbjs/drizzle-adapter -- --project uni
```

Integration tests require the SDK YDB test setup:

```sh
npm run test:live --workspace=@ydbjs/drizzle-adapter
```

The root CI workflow runs the SDK test suite on pull requests with a Docker YDB service, so the adapter integration project is exercised together with the rest of the SDK.

## Error Handling

Execution failures are wrapped in Drizzle query errors with YDB-specific subclasses when the status can be classified:

- `YdbUniqueConstraintViolationError`
- `YdbAuthenticationError`
- `YdbCancelledQueryError`
- `YdbTimeoutQueryError`
- `YdbUnavailableQueryError`
- `YdbOverloadedQueryError`
- `YdbRetryableQueryError`

Mapped errors expose non-enumerable `kind`, `retryable`, `statusCode`, and original YDB diagnostic fields such as `code`, `status`, and `issues` when present.

## Release Gates

Before a release PR is accepted, the SDK CI workflow must pass:

- root build and type packaging checks: `npm run build` and `npm run attw`;
- adapter package surface smoke test: `npm run check:surface --workspace=@ydbjs/drizzle-adapter`;
- adapter unit and live tests through the root test suite, including Docker-backed YDB integration tests.

The repository release workflow stays shared with the SDK and is not customized by the adapter package.
