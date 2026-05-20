---
title: Database API
description: Создание клиента, выполнение YQL и транзакции.
---

# Database API

Объект базы данных, возвращаемый `createDrizzle()`, является основным интерфейсом взаимодействия. Он объединяет возможности построителей запросов Drizzle с функциональностью YDB.

Runnable-приложение, которое покрывает большинство методов этой страницы, находится в разделе [Примеры Drizzle Adapter](/ru/guide/drizzle-adapter/examples).

## Инициализация

Функция `createDrizzle` (алиас `drizzle`) — точка входа для создания экземпляра базы данных.

### Способы конфигурации

- `createDrizzle(options)`: создает экземпляр по строке подключения или существующему клиенту.
- `createDrizzle(callback, config?)`: создает экземпляр поверх кастомного callback-исполнителя (полезно для Remote/Proxy конфигураций).

### Опции

- `connectionString`: строка подключения YDB (например, `grpc://localhost:2136/local`). Адаптер автоматически создает и управляет экземпляром `Driver`.
- `client`: существующий `YdbExecutor` или `YdbTransactionalExecutor`.
- `schema`: объект со схемами таблиц и связей для работы Relational Query API (`db.query.*`).
- `logger`: `true` для стандартного логгера, `false` для отключения или кастомный `Logger` Drizzle.
- `casing`: режим преобразования имен Drizzle (`'snake_case'` или `'camelCase'`).

Пример:

```ts
import { createDrizzle } from '@ydbjs/drizzle-adapter'

const db = createDrizzle({
  connectionString: process.env['YDB_CONNECTION_STRING']!,
  schema,
  logger: true,
})
```

### Управление жизненным циклом

При использовании `connectionString` адаптер владеет базовым драйвером. Используйте `$client` для управления его состоянием:

- `await db.$client.ready()`: позволяет убедиться, что драйвер инициализирован и база доступна.
- `await db.$client.close()`: закрывает пул сессий и освобождает ресурсы драйвера. **Обязательно вызывайте этот метод при завершении работы приложения.**

```ts
await db.$client.ready()
// ... логика приложения ...
await db.$client.close()
```

## Выполнение запросов

Методы для выполнения сырого YQL или объектов-построителей:

| Метод             | Описание                                                |
| :---------------- | :------------------------------------------------------ |
| `.execute(query)` | Выполняет запрос и возвращает типизированный результат. |
| `.all(query)`     | Возвращает все строки в виде массива объектов.          |
| `.get(query)`     | Возвращает первую найденную строку или `undefined`.     |
| `.values(query)`  | Возвращает данные в виде массива массивов значений.     |

Пример:

```ts
import { sql } from 'drizzle-orm'

await db.execute(sql`DELETE FROM users WHERE id = ${1}`)

const rows = await db.all(sql`SELECT * FROM users`)
const user = await db.get(sql`SELECT * FROM users LIMIT 1`)
const ids = await db.values<[number]>(sql`SELECT id FROM users`)

const firstBuilt = await db.get(db.select({ id: users.id, name: users.name }).from(users).limit(1))
```

## Построители запросов

### Выборка (SELECT)

- `db.select(fields?)`, `db.selectDistinct(fields?)`, `db.selectDistinctOn(on, fields?)`: инициализация построителей SELECT.
- `db.with(...queries)`, `db.$with(alias)`: объявление CTE (Common Table Expressions).

### Мутации

| Метод                   | Операция YQL     | Описание                               |
| :---------------------- | :--------------- | :------------------------------------- |
| `db.insert(table)`      | `INSERT INTO`    | Обычная вставка.                       |
| `db.upsert(table)`      | `UPSERT INTO`    | Вставка или обновление по Primary Key. |
| `db.replace(table)`     | `REPLACE INTO`   | Полная замена строки.                  |
| `db.update(table)`      | `UPDATE`         | Частичное обновление.                  |
| `db.delete(table)`      | `DELETE FROM`    | Удаление строк.                        |
| `db.batchUpdate(table)` | (оптимизировано) | Массовое обновление нескольких строк.  |
| `db.batchDelete(table)` | (оптимизировано) | Массовое удаление нескольких строк.    |

### Утилиты

- `db.$count(source, filters?)`: возвращает awaitable count-выражение для эффективного подсчета строк.

```ts
import { eq } from 'drizzle-orm'

const activeCount = await db.$count(users, eq(users.active, true))

const rows = await db.select({ id: users.id, name: users.name }).from(users).limit(10).execute()
```

## Транзакции

Метод `db.transaction()` обеспечивает атомарность выполнения группы операций.

```ts
await db.transaction(
  async (tx) => {
    await tx.insert(users).values({ id: 1, name: 'Alice' }).execute()
    await tx
      .update(stats)
      .set({ count: sql`count + 1` })
      .execute()

    // Ручной откат
    if (someCondition) {
      tx.rollback()
    }
  },
  {
    accessMode: 'read write',
    isolationLevel: 'serializableReadWrite',
    idempotent: true,
  }
)
```

### Опции

- `accessMode`: `'read write'` (по умолчанию) или `'read only'`. Используйте `'read only'` для оптимизации читающих транзакций.
- `isolationLevel`: `'serializableReadWrite'` (рекомендуется для YDB) или `'snapshotReadOnly'`.
- `idempotent`: если `true`, адаптер сможет автоматически перезапустить транзакцию при сетевых ошибках.

## Relational Query API

Если при инициализации была передана `schema`, доступен высокоуровневый API для работы со связями через `db.query.*`.

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

### Опции

- `columns`: включение или исключение конкретных колонок.
- `where`: логика фильтрации.
- `orderBy`: выражения сортировки.
- `limit`, `offset`: пагинация.
- `with`: вложенная загрузка связей.
- `extras`: дополнительные SQL-выражения.

## Служебные свойства

- `$client`: базовый исполнитель. Используется для вызова `ready()` и `close()`.
- `_`: внутренние метаданные Drizzle/адаптера. Не используйте это поле как стабильный API приложения.
