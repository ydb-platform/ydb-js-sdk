---
title: Drizzle — SQL helpers
---

# SQL helpers (@ydbjs/drizzle-adapter/sql)

`@ydbjs/drizzle-adapter/sql` — это набор маленьких функций, которые
возвращают `SQL`-фрагменты. Они композируются с шаблоном `sql\`\`` из
Drizzle, со ссылками на колонки и со слотами builder'а (`.values()`/`.set()`/`.where()`) — везде, где принимается `SQL`-значение.

Цель — держать YDB-специфику (Unwrap для Optional, касты параметров,
конвенции cache-key) в одном месте, чтобы её не переизобретали на каждом
call site.

## Hash UDF

Используются как первая колонка составного первичного ключа, чтобы
распределить записи по tablet'ам. Зачем — см. [Schema → составные PK с
шард-префиксом](./schema#составные-pk-с-шард-префиксом).

| Хелпер                | YQL                                                                    | Вход                      | Возврат  |
| --------------------- | ---------------------------------------------------------------------- | ------------------------- | -------- |
| `numericHash(value)`  | `Unwrap(Digest::NumericHash(CAST(<v> AS Uint64)))`                     | number / bigint / SQL     | `Uint64` |
| `xxHash(value)`       | `Unwrap(Digest::XXH3(CAST(<v> AS String)))`                            | string / Uint8Array / SQL | `Uint64` |
| `crc32c(value)`       | `Unwrap(Digest::Crc32c(CAST(<v> AS String)))`                          | string / Uint8Array / SQL | `Uint32` |
| `crc64(value, init?)` | `Unwrap(Digest::Crc64(CAST(<v> AS String)[, CAST(<init> AS Uint64)]))` | string / Uint8Array / SQL | `Uint64` |

`numericHash` — дефолт для числовых ID; `xxHash` — эквивалент для
строковых ключей. `crc32c` срезает префикс до 32 бит, если этой энтропии
достаточно; `crc64` принимает seed для цепочек.

Обёртка `Unwrap` обязательна — drizzle биндит каждый параметр как
`Optional<T>`, а YDB отказывается принимать `Optional<Uint64>` в колонку
`NOT NULL Uint64`. Хелперы снимают её за вас.

```ts
import { numericHash, xxHash } from '@ydbjs/drizzle-adapter/sql'

await db.insert(users).values({ hash: numericHash(42), id: 42 /* ... */ })
await db.insert(articles).values({ hash: xxHash('intro'), slug: 'intro' /* ... */ })
```

## Текущее время

```ts
import { currentUtcDate, currentUtcDatetime, currentUtcTimestamp } from '@ydbjs/drizzle-adapter/sql'

await db.update(users).set({ updatedAt: currentUtcTimestamp() }).where(eq(users.id, 1)).execute()
```

Все три возвращают `SQL<Date>`. В рамках одного запроса значение
константно — несколько ссылок в одном statement видят один и тот же
момент времени.

Предпочитайте их над `new Date()`, когда нужен серверный timestamp — нет
JS↔server clock skew и значение не запекается в параметры запроса.

## Random с per-row cache key

`Random()`, `RandomNumber()` и `RandomUuid()` в YQL кешируются на call site
на запрос — no-arg форма возвращает одно и то же значение для каждой
строки, чего почти никогда не хочется. Обёртки требуют хотя бы один
cache-key (обычно ссылку на колонку), чтобы заставить пересчитываться по
каждой строке:

```ts
import { randomNumber, randomUuid } from '@ydbjs/drizzle-adapter/sql'
import { sql } from 'drizzle-orm'

// UUID на каждую строку, сидится id строки
await db
  .update(events)
  .set({ traceId: randomUuid(events.id) })
  .execute()

// Uint64 на строку из двух колонок
await db.select({ id: events.id, bucket: randomNumber(events.id, events.tenantId) }).from(events)
```

| Хелпер                  | YQL                    | Возврат         |
| ----------------------- | ---------------------- | --------------- |
| `random(...keys)`       | `Random(<keys>)`       | `Double` (0..1) |
| `randomNumber(...keys)` | `RandomNumber(<keys>)` | `Uint64`        |
| `randomUuid(...keys)`   | `RandomUuid(<keys>)`   | `Uuid`          |

Если действительно нужно одно кешированное значение на весь запрос —
сваливайтесь в `sql\`Random()\``.

## Generic-хелперы

| Хелпер                    | YQL                    | Заметки                                                   |
| ------------------------- | ---------------------- | --------------------------------------------------------- |
| `unwrap(value, message?)` | `Unwrap(<v>[, <msg>])` | Снять `Optional<T>` до `T`; упасть с `message`, если NULL |
| `maxOf(a, b, ...)`        | `MAX_OF(...)`          | N-арный скалярный max — YDB-аналог `GREATEST`             |
| `minOf(a, b, ...)`        | `MIN_OF(...)`          | N-арный скалярный min — YDB-аналог `LEAST`                |

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

`vectorIndex` (из `/schema`) строит k-means tree; хелперы `Knn::*`
формируют запросы:

| Хелпер                              | YQL                                       |
| ----------------------------------- | ----------------------------------------- |
| `knnCosineDistance(vector, target)` | `Knn::CosineDistance(<v>, <t>)`           |
| `knnEuclideanDistance(...)`         | `Knn::EuclideanDistance(<v>, <t>)`        |
| `knnManhattanDistance(...)`         | `Knn::ManhattanDistance(<v>, <t>)`        |
| `knnCosineSimilarity(...)`          | `Knn::CosineSimilarity(<v>, <t>)`         |
| `knnInnerProductSimilarity(...)`    | `Knn::InnerProductSimilarity(<v>, <t>)`   |
| `knnDistance(fn, ...)`              | `Knn::<fn>(...)` (типизированная фабрика) |
| `knnSimilarity(fn, ...)`            | `Knn::<fn>(...)` (типизированная фабрика) |

Парьте с `vectorIndexView(table, indexName)`, чтобы заставить планер
взять конкретный vector-индекс.

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

## Set-операторы, группировка, window-функции

Полный набор YQL-композеров реэкспортирован здесь, чтобы не уходить в
raw `sql\`\`` для типовых форм:

- `union`, `unionAll`, `intersect`, `except`
- `cube`, `rollup`, `groupingSets`, `groupKey`, `grouping`
- `windowDefinition`, `hop`, `hopEnd`, `hopStart`, `sessionStart`, `sessionWindow`
- `matchRecognize`
- `distinctHint`, `uniqueHint`, `asTable`, `values`, `valuesTable`

Они мапятся 1-в-1 на YQL-соответствия; за семантикой аргументов — в YQL
reference.

## Pragmas и scripts

YQL `PRAGMA` и семейство script-билдеров помогают собирать multi-statement
батчи и конфигурировать оптимизатор:

```ts
import { pragma, kMeansTreeSearchTopSize, yqlScript } from '@ydbjs/drizzle-adapter/sql'

let script = yqlScript(
  pragma('ydb.HashJoinMode', "'graceandmap'"),
  kMeansTreeSearchTopSize(64),
  sql`SELECT 1`
)
await db.execute(script)
```

Также есть: `declareParam`, `defineAction`, `doAction`, `doBlock`,
`intoResult`, `commit`.
