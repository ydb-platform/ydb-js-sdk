---
title: Drizzle — Migrations
---

# Migrations (@ydbjs/drizzle-adapter/migrator)

`migrate()` applies a sequence of migrations to a YDB database, records what's
been applied in a bookkeeping table, and (optionally) coordinates with other
deployers through a lock table. The `build*Sql` DDL builders are exposed
alongside for tooling that needs to render statements without running them.

## Folder-based migrations

The drizzle-kit format works as-is — point `migrate()` at the directory and
it reads `meta/_journal.json` plus every `*.sql` next to it:

```ts
import { migrate } from '@ydbjs/drizzle-adapter/migrator'

await migrate(db, { migrationsFolder: './drizzle' })
```

In a deployment script:

```ts
await migrate(db, {
  migrationsFolder: './drizzle',
  migrationsTable: '__migrations',
})
```

`migrationsTable` defaults to `__drizzle_migrations`.

## Inline migrations

Pass `migrations: [...]` for programmatic schemas (e.g. tests, ephemeral
databases). Each entry is `{ name, operations | sql }`:

```ts
import { migrate } from '@ydbjs/drizzle-adapter/migrator'
import { ydbTable, integer, text } from '@ydbjs/drizzle-adapter/schema'

let users = ydbTable('users', {
  id: integer('id').notNull().primaryKey(),
  name: text('name').notNull(),
})

await migrate(db, {
  migrations: [
    {
      name: '001_create_users',
      operations: [{ kind: 'create_table', table: users, ifNotExists: true }],
    },
    {
      name: '002_seed',
      sql: ["UPSERT INTO `users` (id, name) VALUES (1, 'admin')"],
    },
  ],
})
```

Mixing `operations` (typed) and `sql` (raw YQL strings) in the same migration
is supported. `operations` cover `create_table`, `drop_table`,
`add_column`, `drop_column`, `add_index`, `drop_index`, `add_changefeed`,
`drop_changefeed`, `rename_table`, plus topics, replication, transfer, and
ACL operations.

## Distributed lock

When multiple deploy jobs can run in parallel (blue/green, autoscaler restart,
manual `kubectl rollout`), enable the lock table so only one process applies
migrations at a time:

```ts
await migrate(db, {
  migrationsFolder: './drizzle',
  migrationLock: {
    key: 'production',
    leaseMs: 10 * 60 * 1000,
    acquireTimeoutMs: 60 * 1000,
    retryIntervalMs: 300,
  },
})
```

- `key` identifies the lock — use one per logical database
- `leaseMs` is the lease length; if a deployer crashes mid-migration, the
  lease expires after this window so the next deployer can take over
- `acquireTimeoutMs` bounds how long competing deployers wait
- `retryIntervalMs` is the poll interval

The lock table defaults to `<migrationsTable>_lock`; override with
`migrationLock.table`.

## Recovery

A migration can crash mid-way (network blip, OOM, deployer kill). The next
run sees a row in `__migrations` with `status = 'running'` for the same
migration. `migrationRecovery` controls what happens:

```ts
await migrate(db, {
  migrationsFolder: './drizzle',
  migrationRecovery: {
    mode: 'retry',
    staleRunningAfterMs: 60 * 60 * 1000,
  },
})
```

| `mode`              | Behaviour                                                       |
| ------------------- | --------------------------------------------------------------- |
| `'retry'` (default) | After `staleRunningAfterMs`, mark the row `failed` and re-apply |
| `'fail'`            | Abort immediately and surface the stale row to the operator     |
| `'skip'`            | Mark the row `failed` and continue to the next migration        |

Use `'retry'` for stateless DDL (typical case); use `'fail'` if your
migrations have manual cleanup that must happen first.

## DDL builders for tooling

Every YQL statement the migrator emits is also available as a pure builder
function. They take typed table/column/index objects and return strings:

```ts
import {
  buildCreateTableSql,
  buildAlterTableSql,
  buildAddIndexSql,
  buildDropChangefeedSql,
} from '@ydbjs/drizzle-adapter/migrator'

let createSql = buildCreateTableSql(users)
let alterSql = buildAlterTableSql('users', [
  { kind: 'add_column', column: usersWithEmail.email },
  { kind: 'add_index', index: emailIndex },
])
```

The full set covers tables, indexes, column families, changefeeds, topics,
async replication, transfer, views, groups, users, secrets, ACL grants/
revokes, and `ANALYZE` / `RENAME` / `SHOW CREATE`. Reach for these when you
want to dry-run a migration, render diff previews, or feed YQL to an
external tool.

## Running migrations in CI/CD

Run migrations as a single deploy step before app instances start serving
traffic. With the lock table enabled, parallel deploy jobs won't race.

```sh
node scripts/migrate.mjs
```

```ts
// scripts/migrate.mjs
import { createDrizzle } from '@ydbjs/drizzle-adapter'
import { migrate } from '@ydbjs/drizzle-adapter/migrator'

let db = createDrizzle({ connectionString: process.env.YDB_CONNECTION_STRING })
try {
  await migrate(db, {
    migrationsFolder: './drizzle',
    migrationLock: { key: 'production', leaseMs: 600_000, acquireTimeoutMs: 60_000 },
  })
} finally {
  await db.$client.close?.()
}
```

The repository's `examples/drizzle-adapter` demonstrates inline migrations
with the lock + recovery options against a local YDB container.
