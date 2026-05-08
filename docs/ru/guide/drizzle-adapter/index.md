---
title: Drizzle Adapter — Обзор
description: 'Адаптер YDB для Drizzle ORM: схема, запросы, расширения YQL и миграции.'
---

# Drizzle Adapter `@ydbjs/drizzle-adapter`

Drizzle-совместимый API для YDB: DSL описания схемы, построители запросов, расширения YDB/YQL, DDL-хелперы и миграции.

Это высокоуровневый обзор адаптера YDB для Drizzle. Для получения подробной информации перейдите в соответствующие разделы:

- [Опции и API](/ru/guide/drizzle-adapter/options)
- [Database API](/ru/guide/drizzle-adapter/database-api)
- [Схема данных](/ru/guide/drizzle-adapter/schema)
- [Построители запросов](/ru/guide/drizzle-adapter/query-builders)
- [Миграции и DDL](/ru/guide/drizzle-adapter/migrations-ddl)
- [YQL-хелперы](/ru/guide/drizzle-adapter/yql-helpers)
- [Driver, Session, Dialect](/ru/guide/drizzle-adapter/internals)
- [Публичный API](/ru/guide/drizzle-adapter/api-index)
- [Примеры](/ru/guide/drizzle-adapter/examples)

## Быстрый старт

```ts
import { eq } from 'drizzle-orm'
import { createDrizzle, integer, text, ydbTable } from '@ydbjs/drizzle-adapter'

export const users = ydbTable('users', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
})

const db = createDrizzle({
  connectionString: process.env.YDB_CONNECTION_STRING!,
  schema: { users },
})

await db.insert(users).values({ id: 1, name: 'Alice' }).execute()

const row = await db.query.users.findFirst({
  where: (user, { eq }) => eq(user.id, 1),
})

const selected = await db
  .select({ id: users.id, name: users.name })
  .from(users)
  .where(eq(users.id, 1))
  .prepare()
  .get()
```

## Примеры {#examples}

Более крупное runnable-приложение с CRUD, relations, joins, CTE, raw execution, транзакциями, scripts и DDL builders находится в разделе [Примеры](/ru/guide/drizzle-adapter/examples).

### Схема с опциями YDB {#examples-schema}

```ts
import {
  columnFamily,
  index,
  integer,
  partitionByHash,
  tableOptions,
  text,
  timestamp,
  ttl,
  ydbTable,
} from '@ydbjs/drizzle-adapter'

export const events = ydbTable(
  'events',
  {
    id: integer('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    payload: text('payload').notNull(),
    createdAt: timestamp('created_at').notNull(),
  },
  (table) => [
    index('events_tenant_idx').on(table.tenantId),
    partitionByHash(table.tenantId),
    ttl(table.createdAt, 'P30D'),
    columnFamily('hot', { data: 'ssd' }).columns(table.payload),
    tableOptions({ AUTO_PARTITIONING_BY_LOAD: 'ENABLED' }),
  ]
)
```

### CRUD-операции {#examples-crud}

```ts
await db.insert(users).values({ id: 1, name: 'Alice' }).execute()
await db.upsert(users).values({ id: 1, name: 'Alice Updated' }).execute()

const rows = await db.select().from(users).where(eq(users.id, 1)).execute()

await db.update(users).set({ name: 'Alice' }).where(eq(users.id, 1)).execute()
await db.delete(users).where(eq(users.id, 1)).execute()
```

### Отношения (Relations) {#examples-relations}

```ts
const user = await db.query.users.findFirst({
  where: (u, { eq }) => eq(u.id, 1),
  with: {
    posts: {
      limit: 5,
      orderBy: (p, { desc }) => [desc(p.id)],
    },
  },
})
```

### Транзакции {#examples-transactions}

```ts
import { sql } from 'drizzle-orm'

await db.transaction(
  async (tx) => {
    await tx.insert(users).values({ id: 1, name: 'Alice' }).execute()
    await tx
      .update(stats)
      .set({ count: sql`count + 1` })
      .execute()
  },
  { accessMode: 'read write', isolationLevel: 'serializableReadWrite' }
)
```

### Миграции {#examples-migrations}

```ts
import { migrate } from '@ydbjs/drizzle-adapter'

await migrate(db, {
  migrationsFolder: './drizzle',
  migrationLock: true,
})
```

### YQL-хелперы {#examples-yql-helpers}

```ts
import { sql } from 'drizzle-orm'
import { asTable, valuesTable } from '@ydbjs/drizzle-adapter'

await db
  .select({ id: sql`r.id`, name: sql`r.name` })
  .from(asTable('$rows', 'r'))
  .execute()

const valueSource = valuesTable([{ id: 1, name: 'Alice' }], {
  alias: 'v',
  columns: ['id', 'name'],
})
await db
  .select({ id: sql`v.id`, name: sql`v.name` })
  .from(valueSource)
  .execute()
```

### Векторный поиск {#examples-vector-search}

```ts
import { sql } from 'drizzle-orm'
import { knnCosineDistance, vectorIndexView } from '@ydbjs/drizzle-adapter'

const nearest = await db
  .select()
  .from(vectorIndexView(images, 'images_vector_idx', 'images'))
  .orderBy(knnCosineDistance(images.embedding, sql`$target`))
  .limit(10)
  .execute()
```

## Release gates {#release-gates}

Готовность адаптера закрывается проверками SDK CI:

- корневые `npm run build`, `npm run attw` и `npm run test`;
- интеграционные тесты с Docker-backed YDB через Vitest-проект `int`;
- `npm run check:surface --workspace=@ydbjs/drizzle-adapter`, который проверяет root public API, закрытые deep imports и содержимое npm pack.

Release workflow остается общим для SDK и не кастомизируется на уровне пакета адаптера.
