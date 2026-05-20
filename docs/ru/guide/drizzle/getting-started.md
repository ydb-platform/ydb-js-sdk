---
title: Drizzle Adapter — Быстрый старт
---

# Быстрый старт

Этот гайд покрывает установку, настройку подключения, описание схемы, базовые CRUD-операции, транзакции и завершение работы.

## Требования

- Node.js 20.19 или новее.
- `drizzle-orm`, установленный рядом с адаптером.
- База данных YDB — локальная (`grpc://localhost:2136/local`) или удалённая.

## Установка

```sh
npm install @ydbjs/drizzle-adapter drizzle-orm
```

## Подключение

`createDrizzle()` — основная точка входа. `drizzle` — её алиас.

### По строке подключения

Используйте этот способ, когда адаптер должен сам создать и владеть драйвером SDK.

```ts
import { createDrizzle } from '@ydbjs/drizzle-adapter'

const db = createDrizzle({
  connectionString: process.env['YDB_CONNECTION_STRING']!,
})
```

### Существующий драйвер SDK

Если в вашем приложении уже есть `Driver` из `@ydbjs/core`, оберните его в `YdbDriver`.

```ts
import { Driver } from '@ydbjs/core'
import { YdbDriver, createDrizzle } from '@ydbjs/drizzle-adapter'

const driver = new Driver('grpc://localhost:2136/local')
const db = createDrizzle({
  client: new YdbDriver(driver),
})
```

### Callback-исполнитель

Режим callback подходит для тестов, RPC-прокси, serverless-окружений и любого транспорта, отличного от прямого gRPC к YDB.

```ts
import { createDrizzle } from '@ydbjs/drizzle-adapter'

const db = createDrizzle(async (sql, params, method, options) => {
  const rows = await myTransport.execute({
    sql,
    params,
    arrayMode: options?.arrayMode === true,
  })

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

## Описание схемы

Таблицы YDB обязаны иметь первичный ключ. Используйте `ydbTable()` и YDB column builder'ы, экспортируемые адаптером.

```ts
import { integer, text, timestamp, ydbTable } from '@ydbjs/drizzle-adapter/schema'

export const users = ydbTable('users', {
  id: integer('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name'),
  createdAt: timestamp('created_at')
    .notNull()
    .$defaultFn(() => new Date()),
})
```

## CRUD

```ts
import { and, eq, like } from 'drizzle-orm'

await db.insert(users).values({ id: 1, email: 'alice@example.com', name: 'Alice' }).execute()

await db
  .insert(users)
  .values([
    { id: 2, email: 'bob@example.com', name: 'Bob' },
    { id: 3, email: 'charlie@example.com', name: 'Charlie' },
  ])
  .execute()

await db
  .insert(users)
  .values({ id: 1, email: 'alice_new@example.com', name: 'Alice Updated' })
  .onDuplicateKeyUpdate({ set: { name: 'Alice Updated' } })
  .execute()

const filteredUsers = await db
  .select({
    userId: users.id,
    userName: users.name,
  })
  .from(users)
  .where(and(eq(users.id, 1), like(users.email, '%@example.com')))
  .execute()

await db.update(users).set({ name: 'Alice Cooper' }).where(eq(users.id, 1)).execute()
await db.delete(users).where(eq(users.id, 1)).execute()
```

## Транзакции

```ts
import { TransactionRollbackError } from 'drizzle-orm/errors'

try {
  await db.transaction(
    async (tx) => {
      await tx.insert(users).values({ id: 4, email: 'delta@example.com' }).execute()

      const user = await tx.select().from(users).where(eq(users.id, 4)).execute()
      if (user.length === 0) {
        tx.rollback()
      }
    },
    {
      accessMode: 'read write',
      isolationLevel: 'serializableReadWrite',
      idempotent: true,
    }
  )
} catch (error) {
  if (error instanceof TransactionRollbackError) {
    console.log('transaction was rolled back')
  }
}
```

## Проверка соединения

```ts
import { sql } from 'drizzle-orm'

await db.execute(sql`SELECT 1`)
```

## Завершение работы

Если адаптер создавал драйвер из `connectionString`, закройте принадлежащий ему клиент при завершении приложения.

```ts
db.$client.close?.()
```

## Runnable-примеры

Репозиторий SDK включает компактный TypeScript CLI-пример.

```bash
cd examples/drizzle-adapter
npm install
npm start
```

См. [примеры Drizzle Adapter](/ru/guide/drizzle/examples) с соответствующими сниппетами.
