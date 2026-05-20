---
title: Drizzle Adapter — Getting Started
---

# Getting Started

This guide covers installation, connection setup, schema declaration, basic CRUD, transactions, and shutdown.

## Requirements

- Node.js 20.19 or newer.
- `drizzle-orm` installed next to the adapter.
- A YDB database, either local (`grpc://localhost:2136/local`) or remote.

## Install

```sh
npm install @ydbjs/drizzle-adapter drizzle-orm
```

## Connect

`createDrizzle()` is the main entry point. `drizzle` is an alias.

### Connection String

Use this when the adapter should create and own the SDK driver.

```ts
import { createDrizzle } from '@ydbjs/drizzle-adapter'

const db = createDrizzle({
  connectionString: process.env['YDB_CONNECTION_STRING']!,
})
```

### Existing SDK Driver

If your application already owns a `Driver` from `@ydbjs/core`, wrap it with `YdbDriver`.

```ts
import { Driver } from '@ydbjs/core'
import { YdbDriver, createDrizzle } from '@ydbjs/drizzle-adapter'

const driver = new Driver('grpc://localhost:2136/local')
const db = createDrizzle({
  client: new YdbDriver(driver),
})
```

### Callback Executor

Use callback mode for tests, RPC proxies, serverless environments, or any transport that is not direct gRPC to YDB.

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

## Define a Schema

YDB tables must have a primary key. Use `ydbTable()` and YDB column builders exported by the adapter.

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

## Transactions

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

## Smoke Test

```ts
import { sql } from 'drizzle-orm'

await db.execute(sql`SELECT 1`)
```

## Shutdown

If the adapter created the driver from `connectionString`, close the owned client on application shutdown.

```ts
db.$client.close?.()
```

## Runnable Examples

The SDK repository includes a compact TypeScript CLI example and a larger interactive TypeScript lab.

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

See [Drizzle Adapter Examples](/guide/drizzle-adapter/examples) for the matching code snippets.
