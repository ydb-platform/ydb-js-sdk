---
title: Drizzle Adapter — Schema
---

# Schema Definition

The YDB Drizzle adapter provides a specialized DSL for describing YDB tables, supporting all YDB-specific features like TTL, partitioning, and specialized indexes.

## Table Definition

Use `ydbTable` to define your tables. In YDB, a **Primary Key is mandatory**.

```ts
import { integer, text, ydbTable } from '@ydbjs/drizzle-adapter'

export const users = ydbTable('users', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
})
```

### ydbTable Structure

1. **Table Name** (`string`): The name of the table in the database.
2. **Columns** (`object`): Column definitions.
3. **Extra Config** (`callback`, optional): Function to define indexes, constraints, and YDB-specific options.

```ts
export const memberships = ydbTable(
  'memberships',
  {
    userId: integer('user_id').notNull(),
    orgId: integer('org_id').notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.orgId] })]
)
```

### Table Name Customization

Use `ydbTableCreator` to apply a global prefix or transformation to all table names.

```ts
import { ydbTableCreator } from '@ydbjs/drizzle-adapter'

const appTable = ydbTableCreator((name) => `myapp/${name}`)

export const users = appTable('users', {
  /* ... */
})
```

## Data Types

The adapter exports builders for all YDB primitive and composite types.

### Primitive Types

| Function        | YDB Type | TS Type   | Description             |
| :-------------- | :------- | :-------- | :---------------------- |
| `boolean(name)` | `Bool`   | `boolean` | Logical value           |
| `int8(name)`    | `Int8`   | `number`  | 8-bit signed integer    |
| `uint8(name)`   | `Uint8`  | `number`  | 8-bit unsigned integer  |
| `int16(name)`   | `Int16`  | `number`  | 16-bit signed integer   |
| `uint16(name)`  | `Uint16` | `number`  | 16-bit unsigned integer |
| `integer(name)` | `Int32`  | `number`  | 32-bit signed integer   |
| `uint32(name)`  | `Uint32` | `number`  | 32-bit unsigned integer |
| `bigint(name)`  | `Int64`  | `bigint`  | 64-bit signed integer   |
| `uint64(name)`  | `Uint64` | `bigint`  | 64-bit unsigned integer |
| `float(name)`   | `Float`  | `number`  | 32-bit floating point   |
| `double(name)`  | `Double` | `number`  | 64-bit floating point   |

### Strings and Binary

| Function                | YDB Type       | TS Type      | Description             |
| :---------------------- | :------------- | :----------- | :---------------------- |
| `text(name)`            | `Utf8`         | `string`     | Unicode string          |
| `bytes(name)`           | `String`       | `Uint8Array` | Binary data             |
| `uuid(name)`            | `Uuid`         | `string`     | UUID string             |
| `yson(name)`            | `Yson`         | `Uint8Array` | YSON format             |
| `json<T>(name)`         | `Json`         | `T`          | JSON text               |
| `jsonDocument<T>(name)` | `JsonDocument` | `T`          | Binary JSON (optimized) |

### Date and Time

| Function            | YDB Type      | TS Type  | Description                        |
| :------------------ | :------------ | :------- | :--------------------------------- |
| `date(name)`        | `Date`        | `Date`   | Date only (until 2038)             |
| `date32(name)`      | `Date32`      | `Date`   | Date with extended range           |
| `datetime(name)`    | `Datetime`    | `Date`   | Date and time (until 2038)         |
| `datetime64(name)`  | `Datetime64`  | `Date`   | Date and time (extended)           |
| `timestamp(name)`   | `Timestamp`   | `Date`   | Microsecond precision (until 2038) |
| `timestamp64(name)` | `Timestamp64` | `Date`   | Microsecond precision (extended)   |
| `interval(name)`    | `Interval`    | `number` | Interval in microseconds           |

### Mapping Notes

- YDB `String` is binary data in the adapter and maps to `Uint8Array` via `bytes()` or `binary()`.
- Human-readable text should use YDB `Utf8` via `text()`.
- `Int64` and `Uint64` map to `bigint` to avoid precision loss.
- Date/time builders map to JavaScript `Date`; the adapter handles conversion at the driver boundary.
- `json<T>()` and `jsonDocument<T>()` return typed JSON values. Use the generic to document the expected shape.

```ts
import { bigint, bytes, json, text, timestamp, ydbTable } from '@ydbjs/drizzle-adapter'

type Profile = { timezone: string; flags: string[] }

export const profiles = ydbTable('profiles', {
  id: bigint('id').primaryKey(),
  displayName: text('display_name').notNull(),
  avatar: bytes('avatar'),
  settings: json<Profile>('settings'),
  updatedAt: timestamp('updated_at').notNull(),
})
```

## Column Modifiers

- `.primaryKey()`: Part of the primary key.
- `.notNull()`: Disallows `NULL`.
- `.default(value)`: Static default value.
- `.$defaultFn(() => value)`: Dynamic default value.
- `.unique(name?)`: Creates a secondary unique index.
- `.references(() => column)`: Metadata for Relational Query API (YDB doesn't support native Foreign Keys).

## Primary Keys

YDB requires a primary key for every table.

### Single Column

```ts
id: integer('id').primaryKey()
```

### Composite (Table-level)

```ts
export const details = ydbTable(
  'details',
  {
    orderId: integer('order_id').notNull(),
    lineNum: integer('line_num').notNull(),
  },
  (table) => [primaryKey({ columns: [table.orderId, table.lineNum] })]
)
```

## Secondary Indexes

Secondary indexes in YDB are stored as separate internal tables.

```ts
import { index, uniqueIndex } from '@ydbjs/drizzle-adapter'

export const users = ydbTable(
  'users',
  {
    /* ... */
  },
  (table) => [
    index('users_tenant_idx').on(table.tenantId),
    index('users_email_idx').on(table.email).global().sync().cover(table.name),
    uniqueIndex('users_login_idx').on(table.login),
  ]
)
```

- `.global()` / `.local()`: Index locality (Global is default).
- `.sync()` / `.async()`: Write synchronization mode.
- `.cover(...columns)`: Add columns to the index (Covering Index).

## Vector Indexes

YDB supports specialized indexes for AI-driven vector search.

```ts
import { vectorIndex } from '@ydbjs/drizzle-adapter'

export const embeddings = ydbTable(
  'embeddings',
  {
    id: integer('id').primaryKey(),
    vector: bytes('vector').notNull(),
  },
  (table) => [
    vectorIndex('vector_idx', {
      vectorDimension: 1536,
      vectorType: 'float',
      distance: 'cosine',
      clusters: 128,
      levels: 2,
    }).on(table.vector),
  ]
)
```

## Table Options

### Physical Parameters

```ts
import { tableOptions } from '@ydbjs/drizzle-adapter'

tableOptions({
  AUTO_PARTITIONING_BY_LOAD: 'ENABLED',
  KEY_BLOOM_FILTER: 'ENABLED',
})
```

### Time to Live (TTL)

Automatic data expiration.

```ts
import { ttl } from '@ydbjs/drizzle-adapter'

ttl(table.createdAt, 'P30D') // Delete after 30 days
ttl(table.expireAt, '3600', { unit: 'SECONDS' })
```

### Partitioning

```ts
import { partitionByHash } from '@ydbjs/drizzle-adapter'

partitionByHash(table.tenantId)
```

### Column Families

```ts
import { columnFamily } from '@ydbjs/drizzle-adapter'

columnFamily('cold_data', {
  data: 'rot',
  compression: 'zstd',
}).columns(table.bio)
```
