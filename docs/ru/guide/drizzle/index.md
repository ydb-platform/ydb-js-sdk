---
title: Drizzle — Обзор
---

# Drizzle (@ydbjs/drizzle-adapter)

Адаптер YDB для [Drizzle ORM](https://orm.drizzle.team/). Даёт типизированные
схемы, query builder, который генерирует валидный YQL, прямой `db.execute()`
для нестандартных запросов, ранер миграций и эргономичные обёртки над
YDB-специфичными UDF и встроенными функциями.

Когда выбирать этот адаптер:

- Хочется одна кодовая база, которая работает с YDB и через типизированный
  builder, и через сырой YQL по необходимости.
- Нужны миграции с историей и опциональным распределённым lock'ом.
- Нравится DX Drizzle (table-объекты, `db.query.*` relations, prepared
  queries), но при этом важно, чтобы YDB-типы, vector search и идиоматические
  шард-кеи оставались first-class.

Если задача — исключительно динамический YQL с параметризованными шаблонами,
лучше взять `@ydbjs/query` — он легче. Адаптер построен на том же драйвере.

## Установка

```sh
npm install @ydbjs/drizzle-adapter drizzle-orm
```

ESM-only, Node.js 20.19+, peer-зависимость `drizzle-orm@^0.45.2`.

## Точки входа

```ts
import { createDrizzle, YdbDriver } from '@ydbjs/drizzle-adapter'
import { ydbTable, integer, text, primaryKey } from '@ydbjs/drizzle-adapter/schema'
import { numericHash, currentUtcTimestamp } from '@ydbjs/drizzle-adapter/sql'
import { migrate, buildCreateTableSql } from '@ydbjs/drizzle-adapter/migrator'
```

| Subpath     | Поверхность                                                  |
| ----------- | ------------------------------------------------------------ |
| `.`         | Bootstrap: подключение, классы ошибок, реэкспорт `relations` |
| `/schema`   | `ydbTable`, колонки, constraints, индексы, table options     |
| `/sql`      | YQL-хелперы (UDF, built-ins, set-операторы, pragma)          |
| `/migrator` | `migrate()` + `build*Sql` DDL-билдеры + типы миграций        |

Подробности — на страницах [Schema](./schema), [SQL helpers](./sql) и
[Migrations](./migrator).

## Быстрый старт

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

Ведущая колонка `hash` — канонический YDB-паттерн для равномерного
распределения записей по tablet'ам. См. [Schema → составные PK с
шард-префиксом](./schema#составные-pk-с-шард-префиксом).

## Подключение

`createDrizzle()` принимает те же формы, что и upstream `drizzle()` из
drizzle-orm, но всегда оборачивает `YdbDriver`:

```ts
// Connection string
let db = createDrizzle({
  connectionString: 'grpcs://ydb.example.com:2135/your-db',
  schema: { users },
})

// Готовый драйвер (если нужно расшарить с другими YDB-клиентами)
import { YdbDriver } from '@ydbjs/drizzle-adapter'
let driver = new YdbDriver({ connectionString: process.env.YDB_CONNECTION_STRING! })
let db = createDrizzle({ driver, schema: { users } })

// Callback-executor для тестов
let db = createDrizzle(async (query, params, method, options) => {
  return realExecutor(query, params, method, options)
})
```

Если передать connection string, драйвером владеет база и `db.$client.close?.()`
его закрывает. Если передать готовый `YdbDriver`, владение остаётся за вами.

## Транзакции

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

Передавайте `tx` вглубь в функции, которые должны участвовать в транзакции.
Транзакции не nestable через адаптер — открывайте одну границу на единицу
работы. Поддерживаются изоляции `serializableReadWrite` и `snapshotReadOnly`
(последняя read-only по определению; адаптер запрещает мутации в её рамках).

### Когда использовать `idempotent: true`

`idempotent: true` включает retry-политику `@ydbjs/retry`: при retryable-сбое
YDB **весь колбэк перезапускается с нуля**, а не только упавший SQL-стейтмент.
Ставьте только тогда, когда повторный запуск всего колбэка безопасен.

```ts
// ✅ Безопасно — внутри только YDB-мутации
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
// ❌ ОПАСНО — Stripe-платёж улетит дважды
await db.transaction(
  async (tx) => {
    await stripe.charges.create({
      /* ... */
    }) // внешний сайд-эффект!
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

Если не уверены — не ставьте флаг и обрабатывайте retryable-ошибку сами.
Флаг это контракт о _теле колбэка_, а не о SQL внутри него.

## Обработка ошибок

Сбои выполнения оборачиваются в `DrizzleQueryError` с YDB-специфичными
подклассами, когда статус ясно классифицируется:

| Класс                               | Когда                                   |
| ----------------------------------- | --------------------------------------- |
| `YdbUniqueConstraintViolationError` | Нарушение PK или unique-индекса         |
| `YdbAuthenticationError`            | Ошибка аутентификации                   |
| `YdbCancelledQueryError`            | Запрос отменён клиентом или сервером    |
| `YdbTimeoutQueryError`              | Серверный таймаут                       |
| `YdbUnavailableQueryError`          | Кластер не смог обработать запрос       |
| `YdbOverloadedQueryError`           | Tablet перегружен                       |
| `YdbRetryableQueryError`            | Статус намекает, что retry может пройти |

У всех замапленных ошибок есть non-enumerable `kind`, `retryable`,
`statusCode`, плюс исходные диагностические поля YDB (`code`, `status`,
`issues`).

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
    // ветка дедупа
  } else {
    throw error
  }
}
```

## Маппинг типов

| Семейство YDB                                         | Значение JS/TS      |
| ----------------------------------------------------- | ------------------- |
| `Bool`                                                | `boolean`           |
| `Int8`..`Int32`, `Uint8`..`Uint32`, `Float`, `Double` | `number`            |
| `Int64`, `Uint64`                                     | `bigint`            |
| `Utf8`, `Uuid`                                        | `string`            |
| `String`, `Yson`                                      | `Uint8Array`        |
| `Date`, `Datetime`, `Timestamp` и 64-битные варианты  | `Date`              |
| `Json`, `JsonDocument`                                | типизированный JSON |

Для бинарного `String` используйте `bytes()`, для `Utf8` — `text()`.

## Ограничения

- ESM-only, Node.js 20.19+, без CommonJS-сборки.
- `references()` — метаданные для Drizzle relations; YDB не enforces foreign keys.
- Unique-индексы создаются только в `CREATE TABLE`; добавление в существующую таблицу отклоняется DDL-билдером.
- `replace()` это полная замена строки по PK — для частичных изменений используйте `upsert()` или `update()`.
- `sql.raw()`, inline-миграции `sql`, `rawTableOption()`, текст view-запроса, raw ACL permissions и transfer `using` text намеренно доверяют YQL от вызывающего кода.
