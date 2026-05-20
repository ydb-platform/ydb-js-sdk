---
title: Drizzle — Schema
---

# Schema (@ydbjs/drizzle-adapter/schema)

Всё, что импортируется из `@ydbjs/drizzle-adapter/schema`, возвращает
Drizzle-совместимое значение: таблицы, колонки, constraints, индексы и
опции таблицы. Формы повторяют upstream Drizzle; различия — это
YDB-нативные типы, vector-индексы и пара table-level опций.

## Таблицы и колонки

```ts
import {
  bytes,
  index,
  integer,
  primaryKey,
  text,
  timestamp,
  uint64,
  ydbTable,
} from '@ydbjs/drizzle-adapter/schema'

export let users = ydbTable(
  'users',
  {
    hash: uint64('hash').notNull(),
    id: integer('id').notNull(),
    email: text('email').notNull(),
    avatar: bytes('avatar'),
    createdAt: timestamp('created_at').notNull(),
  },
  (t) => [primaryKey(t.hash, t.id), index('users_email_idx').on(t.email)]
)
```

Используйте `ydbTableCreator(prefix)`, если нужно поместить много таблиц
под одним префиксом/схемой.

### Семейства колонок

Полный набор column-builder'ов экспортируется из `/schema`:

| Семейство                                                           | Builder                                                             |
| ------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `Bool`                                                              | `boolean`                                                           |
| `Int8`/`Int16`/`Int32`                                              | `int8` / `int16` / `integer` (alias `int`)                          |
| `Int64`                                                             | `bigint`                                                            |
| `Uint8`/`Uint16`/`Uint32`/`Uint64`                                  | `uint8` / `uint16` / `uint32` / `uint64`                            |
| `Float` / `Double`                                                  | `float` / `double`                                                  |
| `Decimal(p, s)`                                                     | `decimal({ precision, scale })`                                     |
| `DyNumber`                                                          | `dyNumber`                                                          |
| `Utf8`                                                              | `text`                                                              |
| `String` (bytes)                                                    | `bytes` (alias `binary`)                                            |
| `Date` / `Datetime` / `Timestamp`                                   | `date` / `datetime` / `timestamp`                                   |
| `Date32` / `Datetime64` / `Timestamp64` / `Interval` / `Interval64` | `date32` / `datetime64` / `timestamp64` / `interval` / `interval64` |
| `Json` / `JsonDocument`                                             | `json` / `jsonDocument`                                             |
| `Uuid`                                                              | `uuid`                                                              |
| `Yson`                                                              | `yson`                                                              |

Нужен экзотический тип? `customType` отдаёт generic-builder Drizzle —
передайте `dataType: () => 'YourYqlType'` и функции конверсии.

## Составные PK с шард-префиксом

YDB партиционирует row-oriented таблицы по префиксу первичного ключа.
Монотонный PK (auto-increment, timestamp и т.п.) отправляет каждую запись в
один и тот же tablet и превращает шард в bottleneck по записи.

Идиоматическое решение — составной PK `(hash, id)`, где ведущая колонка —
равномерно распределённый хеш натурального ID. `@ydbjs/drizzle-adapter/sql`
даёт YDB-UDF, которые считают хеш на сервере:

```ts
import { primaryKey, uint64, integer, ydbTable } from '@ydbjs/drizzle-adapter/schema'
import { numericHash, xxHash } from '@ydbjs/drizzle-adapter/sql'

// Числовой id (Int32/Int64/Uint64): Digest::NumericHash
let users = ydbTable(
  'users',
  { hash: uint64('hash').notNull(), id: integer('id').notNull() /* ... */ },
  (t) => [primaryKey(t.hash, t.id)]
)
await db.insert(users).values({ hash: numericHash(1), id: 1 /* ... */ })

// Строковый id (email, slug, uuid-строка): Digest::XXH3
let articles = ydbTable(
  'articles',
  { hash: uint64('hash').notNull(), slug: text('slug').notNull() /* ... */ },
  (t) => [primaryKey(t.hash, t.slug)]
)
await db.insert(articles).values({ hash: xxHash('intro'), slug: 'intro' /* ... */ })
```

Оба хелпера оборачивают вызов в `Unwrap(...)`, чтобы результат подошёл
колонке `NOT NULL`. См. [SQL → hash UDFs](./sql#hash-udfs) для
альтернатив `crc32c` / `crc64` и обоснования.

## Constraints

```ts
import { primaryKey, unique } from '@ydbjs/drizzle-adapter/schema'

let products = ydbTable(
  'products',
  {
    /* ... */
  },
  (t) => [primaryKey(t.hash, t.sku), unique('products_sku_uq').on(t.sku)]
)
```

Unique-индексы в YDB только inline — их объявляют в `CREATE TABLE`, добавить
позже нельзя. DDL-билдер адаптера отклоняет изменения unique-индексов именно
поэтому.

## Индексы

```ts
import { index, uniqueIndex, vectorIndex } from '@ydbjs/drizzle-adapter/schema'

let docs = ydbTable(
  'docs',
  {
    /* ... */
  },
  (t) => [
    index('docs_owner_idx').on(t.ownerId).global().sync(),
    uniqueIndex('docs_slug_uq').on(t.slug),
    vectorIndex('docs_emb_idx', {
      vectorType: 'float',
      vectorDimension: 768,
      distance: 'cosine',
      clusters: 64,
      levels: 2,
    }).on(t.embedding),
  ]
)
```

`vectorIndex` строит k-means tree vector index. Парьте его с
`knnCosineDistance` и компанией из `/sql` для nearest-neighbour запросов —
см. [SQL → vector search](./sql#vector-search).

## Опции таблицы

```ts
import {
  columnFamily,
  partitionByHash,
  tableOptions,
  ttl,
  ydbTable,
} from '@ydbjs/drizzle-adapter/schema'

let events = ydbTable(
  'events',
  {
    /* ... */
  },
  (t) => [
    primaryKey(t.hash, t.id),
    tableOptions({
      autoPartitioningByLoad: 'enabled',
      autoPartitioningPartitionSizeMb: 256,
    }),
    partitionByHash(t.hash),
    columnFamily('cold', { compression: 'lz4' }),
    ttl({ column: t.createdAt, unit: 'seconds', interval: 'PT720H' }),
  ]
)
```

`rawTableOption(key, value)` — escape hatch для любой опции, которую
адаптер не моделирует: значение трактуется как доверенный YQL.

## Relations

`@ydbjs/drizzle-adapter` реэкспортирует `relations`, `one`, `many` из
drizzle-orm, чтобы одной зависимостью покрыть и декларацию схемы, и
реляционный API (`db.query.*`). YDB не enforces foreign keys; relations —
это метаданные для джойнов Drizzle.

```ts
import { many, one, relations } from '@ydbjs/drizzle-adapter'

export let usersRelations = relations(users, ({ many }) => ({
  posts: many(posts),
}))

export let postsRelations = relations(posts, ({ one }) => ({
  author: one(users, {
    fields: [posts.userHash, posts.userId],
    references: [users.hash, users.id],
  }),
}))
```

Multi-column `references` соответствует составному `(hash, id)` PK выше.
