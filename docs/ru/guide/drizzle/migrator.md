---
title: Drizzle — Migrations
---

# Migrations (@ydbjs/drizzle-adapter/migrator)

`migrate()` применяет последовательность миграций к YDB-базе, фиксирует
применённые в bookkeeping-таблице и (опционально) координирует параллельных
деплоеров через lock-таблицу. DDL-билдеры `build*Sql` лежат рядом — для
тулинга, которому нужно отрендерить statement без выполнения.

## Folder-based миграции

Формат drizzle-kit работает как есть — укажите `migrate()` на директорию,
и она прочитает `meta/_journal.json` плюс все `*.sql` рядом:

```ts
import { migrate } from '@ydbjs/drizzle-adapter/migrator'

await migrate(db, { migrationsFolder: './drizzle' })
```

В deploy-скрипте:

```ts
await migrate(db, {
  migrationsFolder: './drizzle',
  migrationsTable: '__migrations',
})
```

`migrationsTable` по умолчанию `__drizzle_migrations`.

## Inline-миграции

Передайте `migrations: [...]` для программных схем (тесты, эфемерные
БД). Каждая запись — `{ name, operations | sql }`:

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

Смешивать `operations` (типизированные) и `sql` (сырые YQL-строки) в
одной миграции можно. `operations` покрывают `create_table`, `drop_table`,
`add_column`, `drop_column`, `add_index`, `drop_index`, `add_changefeed`,
`drop_changefeed`, `rename_table`, плюс операции для топиков, репликации,
transfer и ACL.

## Распределённый lock

Когда несколько deploy-задач могут запуститься параллельно (blue/green,
рестарт автоскейлера, ручной `kubectl rollout`), включите lock-таблицу,
чтобы миграции применял только один процесс одновременно:

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

- `key` идентифицирует lock — используйте один на логическую базу
- `leaseMs` — длина lease; если деплоер упал посреди миграции, lease
  истечёт через это окно и следующий деплоер сможет подобрать
- `acquireTimeoutMs` ограничивает, сколько ждут конкурирующие деплоеры
- `retryIntervalMs` — интервал поллинга

Lock-таблица по умолчанию — `<migrationsTable>_lock`; переопределяется
через `migrationLock.table`.

## Recovery

Миграция может упасть посредине (сетевой блип, OOM, kill деплоера).
Следующий запуск увидит в `__migrations` строку со `status = 'running'`
для той же миграции. Что делать — определяет `migrationRecovery`:

```ts
await migrate(db, {
  migrationsFolder: './drizzle',
  migrationRecovery: {
    mode: 'retry',
    staleRunningAfterMs: 60 * 60 * 1000,
  },
})
```

| `mode`              | Поведение                                                            |
| ------------------- | -------------------------------------------------------------------- |
| `'retry'` (default) | После `staleRunningAfterMs` пометить строку `failed` и переприменить |
| `'fail'`            | Сразу прервать и показать оператору stale-строку                     |
| `'skip'`            | Пометить строку `failed` и перейти к следующей миграции              |

Берите `'retry'` для stateless DDL (типичный случай); `'fail'` — если
миграции требуют ручной cleanup перед перезапуском.

## DDL-билдеры для тулинга

Каждый YQL-statement, который генерит мигратор, также доступен как чистая
builder-функция. Они принимают типизированные table/column/index объекты
и возвращают строки:

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

Полный набор покрывает таблицы, индексы, column families, changefeeds,
топики, async-репликацию, transfer, views, groups, users, secrets, ACL
grants/revokes и `ANALYZE` / `RENAME` / `SHOW CREATE`. Полезно, когда нужно
dry-run миграции, рендер diff'а или скормить YQL внешнему инструменту.

## Запуск миграций в CI/CD

Гоняйте миграции одним deploy-шагом до старта приложения. С включённой
lock-таблицей параллельные deploy-задачи не гонятся.

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

В `examples/drizzle-adapter` показаны inline-миграции с lock + recovery
против локального YDB-контейнера.
