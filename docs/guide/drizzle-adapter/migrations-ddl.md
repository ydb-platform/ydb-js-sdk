---
title: Drizzle Adapter — Migrations and DDL
---

# Migrations and DDL

The adapter provides a robust migrator and a set of DDL builders to manage your YDB schema programmatically.

The runnable lab in [Drizzle Adapter Examples](/guide/drizzle-adapter/examples) shows `migrate()` plus live and preview-only DDL builders.

## Migrator (`migrate`)

The `migrate` function applies schema changes while ensuring consistency through distributed locks.

### Basic Usage

```ts
import { migrate } from '@ydbjs/drizzle-adapter'

await migrate(db, {
  migrationsFolder: './drizzle', // Path to drizzle-kit generated files
  migrationLock: true, // Enable distributed locking
})
```

### Inline Migrations

Define migrations directly in your code for dynamic schema management.

```ts
await migrate(db, {
  migrations: [
    {
      name: '0000_init',
      sql: ['CREATE TABLE `users` (id Int32, name Utf8, PRIMARY KEY (id))'],
    },
  ],
})
```

## Migration Lock

To prevent concurrent migrations in multi-instance deployments, the adapter uses a dedicated lock table in YDB.

```ts
await migrate(db, {
  migrationLock: {
    key: 'my_app_deploy',
    leaseMs: 600000, // 10 minutes
    acquireTimeoutMs: 60000, // 1 minute wait
  },
})
```

## CI/CD Pattern

Run migrations as one deployment step before rolling out application instances. Keep `migrationLock` enabled so parallel deploy jobs, retries, and blue/green releases do not apply the same migration twice.

```ts
import { createDrizzle, migrate } from '@ydbjs/drizzle-adapter'

const db = createDrizzle({
  connectionString: process.env['YDB_CONNECTION_STRING']!,
})

try {
  await db.$client.ready?.()
  await migrate(db, {
    migrationsFolder: './drizzle',
    migrationLock: {
      key: process.env['GITHUB_SHA'] ?? 'deploy',
      leaseMs: 10 * 60 * 1000,
      acquireTimeoutMs: 60 * 1000,
      retryIntervalMs: 1000,
    },
    migrationRecovery: {
      mode: 'retry',
      staleRunningAfterMs: 60 * 60 * 1000,
    },
  })
} finally {
  await db.$client.close?.()
}
```

Recommended release checks:

```bash
npm run build -- --filter=@ydbjs/drizzle-adapter
npm run attw -- --filter=@ydbjs/drizzle-adapter
npm run test --workspace=@ydbjs/drizzle-adapter -- --project uni
npm run test:live --workspace=@ydbjs/drizzle-adapter
```

## Recovery Strategies

If a migration is interrupted (e.g., process crash), the history record might get stuck in `running` status.

- `mode: 'error'` (Default): Fails if a stuck migration is detected.
- `mode: 'retry'`: Resets and retries the migration if it has been stuck for longer than `staleRunningAfterMs`.

```ts
await migrate(db, {
  migrationRecovery: {
    mode: 'retry',
    staleRunningAfterMs: 3600000, // 1 hour
  },
})
```

## DDL Builders

The adapter exports low-level functions to generate YQL for schema management.

### Table Operations

- `buildCreateTableSql(table, options?)`: Full `CREATE TABLE` command.
- `buildDropTableSql(table, options?)`: `DROP TABLE`.
- `buildRenameTableSql(table, newName)`: `RENAME TABLE`.

### Column Operations

- `buildAddColumnsSql(table, columns)`: Add new columns.
- `buildDropColumnsSql(table, names)`: Remove columns by name.

### Index and CDC

- `buildAddIndexSql(table, index)`: Add secondary index.
- `buildDropIndexSql(table, indexName)`: Remove index.
- `buildAddChangefeedSql(table, name, options)`: Configure CDC (Change Data Capture).

### Service Objects

Manage YDB infrastructure via code:

- **Topics**: `buildCreateTopicSql`, `buildAlterTopicSql`, `buildDropTopicSql`.
- **RBAC**: `buildCreateUserSql`, `buildGrantSql`, `buildRevokeSql`.
- **Views**: `buildCreateViewSql`, `buildDropViewSql`.
- **Secrets**: `buildCreateSecretSql`.

## DDL Safety

DDL builders escape table, column, index, family, topic, user, group, and changefeed identifiers. Option names are validated as simple identifiers before rendering.

Raw YQL surfaces remain caller-controlled by design: inline migration `sql`, `rawTableOption()`, view query text, raw ACL permissions, and transfer `using` text. Treat those values as trusted code, not user input.
