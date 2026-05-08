---
title: Drizzle Adapter — Миграции и DDL
---

# Миграции и DDL

Адаптер предоставляет надежный мигратор и набор DDL-построителей для программного управления схемой YDB.

Runnable-приложение из раздела [Примеры Drizzle Adapter](/ru/guide/drizzle-adapter/examples) показывает `migrate()` и live/preview-only DDL builders.

## Мигратор (`migrate`)

Функция `migrate` применяет изменения схемы, гарантируя консистентность через распределенные блокировки.

### Основное использование

```ts
import { migrate } from '@ydbjs/drizzle-adapter'

await migrate(db, {
  migrationsFolder: './drizzle', // Путь к файлам, сгенерированным drizzle-kit
  migrationLock: true, // Включить распределенную блокировку
})
```

### Inline миграции

Описывайте миграции прямо в коде для динамического управления схемой.

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

## Блокировки миграций (Migration Lock)

Чтобы предотвратить одновременное выполнение миграций при развертывании в несколько инстансов, адаптер использует специальную таблицу блокировок в YDB.

```ts
await migrate(db, {
  migrationLock: {
    key: 'my_app_deploy',
    leaseMs: 600000, // 10 минут удержания
    acquireTimeoutMs: 60000, // 1 минута ожидания
  },
})
```

## Паттерн CI/CD

Запускайте миграции отдельным шагом деплоя до старта новых инстансов приложения. Оставляйте `migrationLock` включенным, чтобы параллельные jobs, retry и blue/green deploy не применили одну миграцию дважды.

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

Рекомендуемые release-проверки:

```bash
npm run build -- --filter=@ydbjs/drizzle-adapter
npm run attw -- --filter=@ydbjs/drizzle-adapter
npm run test --workspace=@ydbjs/drizzle-adapter -- --project uni
npm run test:live --workspace=@ydbjs/drizzle-adapter
```

## Стратегии восстановления

Если миграция была прервана (например, при падении процесса), запись в истории может зависнуть в статусе `running`.

- `mode: 'error'` (по умолчанию): Выдает ошибку при обнаружении зависшей миграции.
- `mode: 'retry'`: Сбрасывает и перезапускает миграцию, если она висит дольше, чем `staleRunningAfterMs`.

```ts
await migrate(db, {
  migrationRecovery: {
    mode: 'retry',
    staleRunningAfterMs: 3600000, // 1 час
  },
})
```

## DDL-построители

Адаптер экспортирует низкоуровневые функции для генерации YQL управления схемой.

### Операции над таблицами

- `buildCreateTableSql(table, options?)`: Полная команда `CREATE TABLE`.
- `buildDropTableSql(table, options?)`: `DROP TABLE`.
- `buildRenameTableSql(table, newName)`: `RENAME TABLE`.

### Операции над колонками

- `buildAddColumnsSql(table, columns)`: Добавление новых колонок.
- `buildDropColumnsSql(table, names)`: Удаление колонок по именам.

### Индексы и CDC

- `buildAddIndexSql(table, index)`: Добавление вторичного индекса.
- `buildDropIndexSql(table, indexName)`: Удаление индекса.
- `buildAddChangefeedSql(table, name, options)`: Настройка потока изменений (CDC).

### Системные объекты

Управляйте инфраструктурой YDB через код:

- **Топики**: `buildCreateTopicSql`, `buildAlterTopicSql`, `buildDropTopicSql`.
- **RBAC**: `buildCreateUserSql`, `buildGrantSql`, `buildRevokeSql`.
- **Вью**: `buildCreateViewSql`, `buildDropViewSql`.
- **Секреты**: `buildCreateSecretSql`.

## Безопасность DDL

DDL builders экранируют имена таблиц, колонок, индексов, семейств колонок, топиков, пользователей, групп и changefeed. Имена опций проверяются как простые идентификаторы до рендера.

Raw YQL поверхности остаются под ответственностью вызывающего кода: inline migration `sql`, `rawTableOption()`, текст view query, raw ACL permissions и transfer `using`. Считайте эти значения trusted code, а не пользовательским вводом.
