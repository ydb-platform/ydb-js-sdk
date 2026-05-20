---
title: Drizzle Adapter — YQL Helpers
---

# YQL Helpers

The adapter includes specialized tools for building advanced analytical queries and scripts directly in YQL.

The runnable lab in [Drizzle Adapter Examples](/guide/drizzle-adapter/examples) includes live and preview-only scenarios for these helpers.

## SELECT Sources

### `asTable(binding, alias?)`

Use a YQL variable (like `List<Struct>`) as a table source in `FROM`.

```ts
import { sql } from 'drizzle-orm'
import { asTable } from '@ydbjs/drizzle-adapter'

await db
  .select({ id: sql`t.id`, name: sql`t.name` })
  .from(asTable('$my_list', 't'))
  .execute()
```

### `valuesTable(rows, options?)`

Create a temporary data source from an array of objects (SQL `VALUES` equivalent).

```ts
import { sql } from 'drizzle-orm'
import { valuesTable } from '@ydbjs/drizzle-adapter'

const v = valuesTable([{ id: 1, name: 'Alice' }], {
  alias: 'v',
  columns: ['id', 'name'],
})

await db
  .select({ id: sql`v.id`, name: sql`v.name` })
  .from(v)
  .execute()
```

## Analytical Functions (OLAP)

Use these helpers inside `.groupBy()` for advanced aggregation.

- `rollup(...columns)`: Hierarchical sub-totals.
- `cube(...columns)`: Sub-totals for all combinations.
- `groupingSets(...sets)`: Custom grouping sets.
- `grouping(column)`: Detects if a row is a sub-total for the column.

```ts
import { rollup } from '@ydbjs/drizzle-adapter'

await db
  .select({ city: sales.city, total: sql`sum(amount)` })
  .from(sales)
  .groupBy(rollup(sales.country, sales.city))
  .execute()
```

## Time Windows

Streaming and time-series aggregation helpers:

- `sessionWindow(column, timeout)`: Group events into sessions.
- `hop(column, hop, window)`: Sliding window aggregation.

## Vector Search (KNN)

Distance and similarity functions for AI-driven search, typically used in `orderBy`.

| Function                            | Description               |
| :---------------------------------- | :------------------------ |
| `knnCosineDistance(v1, v2)`         | Cosine distance.          |
| `knnEuclideanDistance(v1, v2)`      | Euclidean distance.       |
| `knnInnerProductSimilarity(v1, v2)` | Inner product similarity. |

```ts
import { sql } from 'drizzle-orm'
import { knnCosineDistance } from '@ydbjs/drizzle-adapter'

const nearest = await db
  .select()
  .from(images)
  .orderBy(knnCosineDistance(images.embedding, sql`$target`))
  .limit(10)
  .execute()
```

## YQL Scripts

The `yqlScript` helper allows combining multiple commands, pragmas, and parameters into a single atomic execution block.

```ts
import { sql } from 'drizzle-orm'
import { declareParam, pragma, yqlScript } from '@ydbjs/drizzle-adapter'

await db.execute(
  yqlScript(
    pragma('TablePathPrefix', '/local'),
    declareParam('$userId', 'Int32'),
    sql`UPSERT INTO users (id) VALUES ($userId);`
  )
)
```

- `pragma(name, value)`: Set execution settings.
- `declareParam(name, type)`: Explicitly declare YQL parameter types.
- `defineAction(name, params, statements)`: Create reusable macros.
- `doAction(name, args)`: Call defined actions.
