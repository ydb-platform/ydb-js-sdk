---
title: Быстрый старт
description: Установка, настройка подключения и базовые операции с YDB.
---

В этом разделе описаны шаги по установке адаптера, настройке подключения к YDB и выполнению первых операций.

## Требования

- **Node.js**: версия 20 или новее.
- **Drizzle ORM**: должен быть установлен параллельно с адаптером.
- **YDB**: доступная база данных (локальная через Docker или облачная в Yandex Cloud).

## Установка

Установите адаптер и `drizzle-orm`:

```sh
npm install @ydbjs/drizzle-adapter drizzle-orm
```

## Подключение к базе данных

Адаптер поддерживает три основных способа инициализации через функцию `createDrizzle` (или её алиас `drizzle`).

### 1. По строке подключения (рекомендуется)

Самый простой способ, при котором адаптер сам создаёт и управляет `Driver` из `@ydbjs/core`.

```ts
import { createDrizzle } from '@ydbjs/drizzle-adapter'

const db = createDrizzle({
  connectionString: process.env.YDB_CONNECTION_STRING!, // Например, grpc://localhost:2136/local
})
```

### 2. Через существующий клиент YDB

Если в вашем приложении уже инициализирован `Driver` из `@ydbjs/core`, оберните его в `YdbDriver`
и передайте как `client`.

```ts
import { Driver } from '@ydbjs/core'
import { YdbDriver, createDrizzle } from '@ydbjs/drizzle-adapter'

const driver = new Driver('grpc://localhost:2136/local')

const db = createDrizzle({
  client: new YdbDriver(driver),
})
```

### 3. Через callback (для тестов или прокси)

Позволяет полностью переопределить транспортный слой. Полезно для написания моков или использования специфичных прокси-серверов.

```ts
import { createDrizzle } from '@ydbjs/drizzle-adapter'

const db = createDrizzle(async (sql, params, method, options) => {
  // sql — строка YQL
  // params — массив параметров
  // method — тип операции: execute или all
  const rows = await myCustomExecute(sql, params, method, options)
  return {
    rows,
    rowCount: rows.length,
    command: method,
    meta: {
      arrayMode: options?.arrayMode === true,
      typings: options?.typings,
    },
  }
})
```

## Определение схемы

В YDB таблицы описываются с помощью `ydbTable`. **Важно:** каждая таблица YDB обязана иметь первичный ключ (Primary Key).

```ts
import { integer, text, timestamp, ydbTable } from '@ydbjs/drizzle-adapter'

export const users = ydbTable('users', {
  id: integer('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name'),
  createdAt: timestamp('created_at')
    .notNull()
    .$defaultFn(() => new Date()),
})
```

## Базовый CRUD

Для выполнения запросов используйте созданный объект `db`.

### Вставка данных (Insert / Upsert)

```ts
// Одиночная вставка
await db.insert(users).values({ id: 1, email: 'alice@example.com', name: 'Alice' }).execute()

// Batch insert (вставка нескольких строк за один запрос)
await db
  .insert(users)
  .values([
    { id: 2, email: 'bob@example.com', name: 'Bob' },
    { id: 3, email: 'charlie@example.com', name: 'Charlie' },
  ])
  .execute()

// Upsert (вставка или обновление при конфликте ключей)
await db
  .insert(users)
  .values({ id: 1, email: 'alice_new@example.com', name: 'Alice Updated' })
  .onDuplicateKeyUpdate({ set: { name: 'Alice Updated' } })
  .execute()
```

### Выборка данных (Select)

```ts
import { eq, like, and } from 'drizzle-orm'

// Простая выборка всех полей
const allUsers = await db.select().from(users).execute()

// Выборка с фильтрацией и выбором конкретных полей
const filteredUsers = await db
  .select({
    userId: users.id,
    userName: users.name,
  })
  .from(users)
  .where(and(eq(users.id, 1), like(users.email, '%@example.com')))
  .execute()
```

### Обновление данных (Update)

```ts
await db.update(users).set({ name: 'Alice Cooper' }).where(eq(users.id, 1)).execute()
```

### Удаление данных (Delete)

```ts
await db.delete(users).where(eq(users.id, 1)).execute()
```

## Транзакции

Транзакции в YDB поддерживают различные уровни изоляции и режимы доступа.

```ts
import { TransactionRollbackError } from 'drizzle-orm/errors'

try {
  await db.transaction(
    async (tx) => {
      await tx.insert(users).values({ id: 4, email: 'delta@example.com' }).execute()

      // Вложенная логика
      const user = await tx.select().from(users).where(eq(users.id, 4)).execute()

      if (user.length === 0) {
        tx.rollback() // Ручной откат транзакции
      }
    },
    {
      accessMode: 'read write', // Важно для операций записи
      isolationLevel: 'serializableReadWrite',
    }
  )
} catch (e) {
  if (e instanceof TransactionRollbackError) {
    console.log('Транзакция была отменена')
  }
}
```

## Проверка соединения

Для smoke-тестирования доступности базы данных выполните простой запрос:

```ts
import { sql } from 'drizzle-orm'

await db.execute(sql`SELECT 1`)
```

## Завершение работы

Если адаптер создавал драйвер самостоятельно (через `connectionString`), рекомендуется закрыть соединение при завершении работы приложения:

```ts
db.$client.close?.()
```

## Runnable-примеры

В репозитории SDK есть компактный TypeScript CLI-пример и более крупная интерактивная TypeScript-лаборатория.

```bash
cd examples/drizzle-adapter
npm install
npm start
```

```bash
cd examples/drizzle-adapter-lab
npm install
npm run db:up
npm start
```

См. [примеры Drizzle Adapter](/ru/guide/drizzle-adapter/examples) с теми же паттернами кода.
