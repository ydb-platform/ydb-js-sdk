---
title: Drizzle Adapter — Overview
---

# Drizzle Adapter `@ydbjs/drizzle-adapter`

Drizzle-compatible database API, schema DSL, YDB/YQL query extensions, DDL builders, and migrations for YDB.

This is the high-level overview of the YDB Drizzle adapter. For details, continue with:

- [Options & API](/guide/drizzle-adapter/options)
- [Database API](/guide/drizzle-adapter/database-api)
- [Schema Definition](/guide/drizzle-adapter/schema)
- [Query Builders](/guide/drizzle-adapter/query-builders)
- [Migrations and DDL](/guide/drizzle-adapter/migrations-ddl)
- [YQL Helpers](/guide/drizzle-adapter/yql-helpers)
- [Driver, Session, Dialect](/guide/drizzle-adapter/internals)
- [Public API](/guide/drizzle-adapter/api-index)
- [Examples](/guide/drizzle-adapter/examples)

## Quick Start

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

## Examples {#examples}

For a larger runnable app that covers CRUD, relations, joins, CTE, raw execution, transactions, scripts, and DDL builders, see [Examples](/guide/drizzle-adapter/examples).

### Schema with YDB options {#examples-schema}

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

### CRUD {#examples-crud}

```ts
await db.insert(users).values({ id: 1, name: 'Alice' }).execute()
await db.upsert(users).values({ id: 1, name: 'Alice Updated' }).execute()

const rows = await db.select().from(users).where(eq(users.id, 1)).execute()

await db.update(users).set({ name: 'Alice' }).where(eq(users.id, 1)).execute()
await db.delete(users).where(eq(users.id, 1)).execute()
```

### Relations {#examples-relations}

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

### Transactions {#examples-transactions}

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

### Migrations {#examples-migrations}

```ts
import { migrate } from '@ydbjs/drizzle-adapter'

await migrate(db, {
  migrationsFolder: './drizzle',
  migrationLock: true,
})
```

### YQL helpers {#examples-yql-helpers}

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

### Vector search {#examples-vector-search}

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

## Release Gates {#release-gates}

Adapter readiness is gated by the SDK CI workflow:

- root `npm run build`, `npm run attw`, and `npm run test`;
- Docker-backed YDB integration tests through the Vitest `int` project;
- `npm run check:surface --workspace=@ydbjs/drizzle-adapter`, which validates the root public API, closed deep imports, and npm pack contents.

The repository release workflow stays shared with the SDK and is not customized by the adapter package.
