---
title: Drizzle — Schema
---

# Schema (@ydbjs/drizzle-adapter/schema)

Everything you import from `@ydbjs/drizzle-adapter/schema` produces a
Drizzle-compatible value: tables, columns, constraints, indexes, and table
options. The shapes follow the upstream Drizzle conventions; the differences
are YDB-native types, vector indexes, and a few table-level options.

## Tables and columns

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

Use `ydbTableCreator(prefix)` when you want to namespace many tables under one
schema/prefix.

### Column families

The full column-builder set is exported from `/schema`:

| Family                                                              | Builder                                                             |
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

Need an exotic type? `customType` exposes Drizzle's generic builder; supply a
`dataType: () => 'YourYqlType'` and conversion functions.

## Shard-prefix primary keys

YDB partitions row-oriented tables by primary-key prefix. A monotonically
growing PK (auto-increment, timestamp, etc.) sends every insert to the same
tablet and turns one shard into a write bottleneck.

The idiomatic fix is a composite PK `(hash, id)` where the leading column is a
uniformly distributed hash of the natural id. `@ydbjs/drizzle-adapter/sql`
exposes the YDB UDFs that compute the hash server-side:

```ts
import { primaryKey, uint64, integer, ydbTable } from '@ydbjs/drizzle-adapter/schema'
import { numericHash, xxHash } from '@ydbjs/drizzle-adapter/sql'

// Numeric id (Int32/Int64/Uint64): Digest::NumericHash
let users = ydbTable(
  'users',
  { hash: uint64('hash').notNull(), id: integer('id').notNull() /* ... */ },
  (t) => [primaryKey(t.hash, t.id)]
)
await db.insert(users).values({ hash: numericHash(1), id: 1 /* ... */ })

// String id (email, slug, uuid string): Digest::XXH3
let articles = ydbTable(
  'articles',
  { hash: uint64('hash').notNull(), slug: text('slug').notNull() /* ... */ },
  (t) => [primaryKey(t.hash, t.slug)]
)
await db.insert(articles).values({ hash: xxHash('intro'), slug: 'intro' /* ... */ })
```

Both helpers wrap the call in `Unwrap(...)` so the result fits the `NOT NULL`
column. See [SQL → hash UDFs](./sql#hash-udfs) for `crc32c` / `crc64`
alternatives and the rationale.

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

Unique indexes are inline-only in YDB — they must be declared with
`CREATE TABLE`, not added later. The adapter rejects unique-index changes from
the DDL builder for that reason.

## Indexes

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

`vectorIndex` builds a k-means tree vector index. Pair it with
`knnCosineDistance` and friends from `/sql` for nearest-neighbour queries —
see [SQL → vector search](./sql#vector-search).

## Table options

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

`rawTableOption(key, value)` is an escape hatch for any option the adapter
doesn't model — the value is trusted YQL.

## Relations

`@ydbjs/drizzle-adapter` re-exports `relations`, `one`, `many` from
drizzle-orm so a single dependency covers schema declaration and the
relational query API (`db.query.*`). YDB has no foreign-key enforcement;
relations are metadata for Drizzle joins.

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

Multi-column `references` matches the composite `(hash, id)` PK pattern above.
