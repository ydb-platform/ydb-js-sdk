---
title: Drizzle — SQL helpers
---

# SQL helpers (@ydbjs/drizzle-adapter/sql)

`@ydbjs/drizzle-adapter/sql` is a collection of small functions that return
`SQL` fragments. They compose with Drizzle's `sql\`\``template, with column
references, and with the query-builder`.values()`/`.set()`/`.where()`slots — anywhere a`SQL` value is accepted.

The goal is to keep YDB-specific incantations (Optional unwrap, parameter
casts, cache-key conventions) in one place so they don't get reinvented at
every call site.

## Hash UDFs

Used as the first column of a composite primary key to spread writes across
tablets. See [Schema → shard-prefix primary keys](./schema#shard-prefix-primary-keys)
for the why.

| Helper                | YQL emitted                                                            | Input                     | Return   |
| --------------------- | ---------------------------------------------------------------------- | ------------------------- | -------- |
| `numericHash(value)`  | `Unwrap(Digest::NumericHash(CAST(<v> AS Uint64)))`                     | number / bigint / SQL     | `Uint64` |
| `xxHash(value)`       | `Unwrap(Digest::XXH3(CAST(<v> AS String)))`                            | string / Uint8Array / SQL | `Uint64` |
| `crc32c(value)`       | `Unwrap(Digest::Crc32c(CAST(<v> AS String)))`                          | string / Uint8Array / SQL | `Uint32` |
| `crc64(value, init?)` | `Unwrap(Digest::Crc64(CAST(<v> AS String)[, CAST(<init> AS Uint64)]))` | string / Uint8Array / SQL | `Uint64` |

`numericHash` is the right default for numeric ids; `xxHash` is the
string-key equivalent. `crc32c` halves the prefix width when 32 bits of
entropy is enough; `crc64` accepts a seed for chaining.

The `Unwrap` wrap is non-negotiable — drizzle binds every parameter as
`Optional<T>` and YDB rejects `Optional<Uint64>` for a `NOT NULL Uint64`
column. The helpers strip it for you.

```ts
import { numericHash, xxHash } from '@ydbjs/drizzle-adapter/sql'

await db.insert(users).values({ hash: numericHash(42), id: 42 /* ... */ })
await db.insert(articles).values({ hash: xxHash('intro'), slug: 'intro' /* ... */ })
```

## Current time

```ts
import { currentUtcDate, currentUtcDatetime, currentUtcTimestamp } from '@ydbjs/drizzle-adapter/sql'

await db.update(users).set({ updatedAt: currentUtcTimestamp() }).where(eq(users.id, 1)).execute()
```

All three return `SQL<Date>`. The value is constant within a single query, so
multiple references in the same statement see the same instant.

These are preferred over `new Date()` whenever you need a server-side
timestamp — there's no JS↔server clock skew to think about and the value
isn't baked into the query parameters.

## Random with per-row cache keys

`Random()`, `RandomNumber()`, and `RandomUuid()` in YQL are cached per call
site per query — the no-arg form returns the same value for every row, which
is almost never what you want. The wrappers require at least one cache key
(usually a column reference) to force per-row re-evaluation:

```ts
import { randomNumber, randomUuid } from '@ydbjs/drizzle-adapter/sql'
import { sql } from 'drizzle-orm'

// Per-row UUID seeded by the row's id
await db
  .update(events)
  .set({ traceId: randomUuid(events.id) })
  .execute()

// Per-row Uint64 derived from two columns
await db.select({ id: events.id, bucket: randomNumber(events.id, events.tenantId) }).from(events)
```

| Helper                  | YQL                    | Return          |
| ----------------------- | ---------------------- | --------------- |
| `random(...keys)`       | `Random(<keys>)`       | `Double` (0..1) |
| `randomNumber(...keys)` | `RandomNumber(<keys>)` | `Uint64`        |
| `randomUuid(...keys)`   | `RandomUuid(<keys>)`   | `Uuid`          |

If you genuinely want one cached value for the whole query, drop down to
`sql\`Random()\``.

## Generic helpers

| Helper                    | YQL                    | Notes                                                   |
| ------------------------- | ---------------------- | ------------------------------------------------------- |
| `unwrap(value, message?)` | `Unwrap(<v>[, <msg>])` | Strip `Optional<T>` to `T`; fail with `message` if NULL |
| `maxOf(a, b, ...)`        | `MAX_OF(...)`          | N-ary scalar max — YDB's `GREATEST`                     |
| `minOf(a, b, ...)`        | `MIN_OF(...)`          | N-ary scalar min — YDB's `LEAST`                        |

```ts
import { maxOf, minOf, unwrap } from '@ydbjs/drizzle-adapter/sql'

await db
  .update(rates)
  .set({
    effective: maxOf(rates.start, currentUtcDate()),
    expires: minOf(rates.end, sql`Date('2099-01-01')`),
  })
  .execute()

let value = await db.execute(sql`SELECT ${unwrap(sql`Just(7)`, 'must not be null')} AS v`)
```

## Vector search (Knn)

`vectorIndex` (from `/schema`) builds the k-means tree; the `Knn::*` helpers
form the queries:

| Helper                              | YQL                                     |
| ----------------------------------- | --------------------------------------- |
| `knnCosineDistance(vector, target)` | `Knn::CosineDistance(<v>, <t>)`         |
| `knnEuclideanDistance(...)`         | `Knn::EuclideanDistance(<v>, <t>)`      |
| `knnManhattanDistance(...)`         | `Knn::ManhattanDistance(<v>, <t>)`      |
| `knnCosineSimilarity(...)`          | `Knn::CosineSimilarity(<v>, <t>)`       |
| `knnInnerProductSimilarity(...)`    | `Knn::InnerProductSimilarity(<v>, <t>)` |
| `knnDistance(fn, ...)`              | `Knn::<fn>(...)` (typed factory)        |
| `knnSimilarity(fn, ...)`            | `Knn::<fn>(...)` (typed factory)        |

Pair with `vectorIndexView(table, indexName)` to force the planner to use a
specific vector index.

```ts
import { sql } from 'drizzle-orm'
import { knnCosineSimilarity } from '@ydbjs/drizzle-adapter/sql'
import { vectorIndexView } from '@ydbjs/drizzle-adapter/schema'

let similar = await db
  .select({
    id: docs.id,
    similarity: knnCosineSimilarity(docs.embedding, sql`$target`),
  })
  .from(docs)
  .view(vectorIndexView(docs, 'docs_emb_idx'))
  .orderBy(sql`similarity DESC`)
  .limit(10)
```

## Set operators, grouping, windowing

The full set of YQL composers is re-exported here so you don't have to drop
to raw `sql\`\`` for common shapes:

- `union`, `unionAll`, `intersect`, `except`
- `cube`, `rollup`, `groupingSets`, `groupKey`, `grouping`
- `windowDefinition`, `hop`, `hopEnd`, `hopStart`, `sessionStart`, `sessionWindow`
- `matchRecognize`
- `distinctHint`, `uniqueHint`, `asTable`, `values`, `valuesTable`

These map one-to-one with their YQL counterparts; refer to the YQL reference
for argument semantics.

## Pragmas and scripts

YQL `PRAGMA` and the script-builder family help you compose multi-statement
batches and configure the optimizer:

```ts
import { pragma, kMeansTreeSearchTopSize, yqlScript } from '@ydbjs/drizzle-adapter/sql'

let script = yqlScript(
  pragma('ydb.HashJoinMode', "'graceandmap'"),
  kMeansTreeSearchTopSize(64),
  sql`SELECT 1`
)
await db.execute(script)
```

Also available: `declareParam`, `defineAction`, `doAction`, `doBlock`,
`intoResult`, `commit`.
