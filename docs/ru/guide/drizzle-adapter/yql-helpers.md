---
title: Drizzle Adapter — YQL-хелперы
---

# YQL-хелперы

Адаптер включает специализированные инструменты для построения сложных аналитических запросов и выполнения скриптов напрямую в YQL.

В runnable-приложении из раздела [Примеры Drizzle Adapter](/ru/guide/drizzle-adapter/examples) есть live и preview-only сценарии для этих хелперов.

## Источники данных для SELECT

### `asTable(binding, alias?)`

Использование переменной YQL (например, `List<Struct>`) как источника таблицы в `FROM`.

```ts
import { sql } from 'drizzle-orm'
import { asTable } from '@ydbjs/drizzle-adapter'

await db
  .select({ id: sql`t.id`, name: sql`t.name` })
  .from(asTable('$my_list', 't'))
  .execute()
```

### `valuesTable(rows, options?)`

Создание временного источника данных из массива объектов (аналог `VALUES` в SQL).

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

## Аналитические функции (OLAP)

Используйте эти хелперы внутри `.groupBy()` для продвинутой агрегации.

- `rollup(...columns)`: иерархические итоги.
- `cube(...columns)`: итоги для всех комбинаций.
- `groupingSets(...sets)`: произвольные наборы группировок.
- `grouping(column)`: позволяет определить, является ли строка итоговой.

```ts
import { rollup } from '@ydbjs/drizzle-adapter'

await db
  .select({ city: sales.city, total: sql`sum(amount)` })
  .from(sales)
  .groupBy(rollup(sales.country, sales.city))
  .execute()
```

## Временные окна (Time Windows)

Хелперы для потоковой агрегации и обработки временных рядов:

- `sessionWindow(column, timeout)`: группировка событий в сессии.
- `hop(column, hop, window)`: скользящие окна агрегации.

## Векторный поиск (KNN)

Функции расстояния и близости для AI-поиска, обычно используемые в `orderBy`.

| Функция                             | Описание                           |
| :---------------------------------- | :--------------------------------- |
| `knnCosineDistance(v1, v2)`         | Косинусное расстояние.             |
| `knnEuclideanDistance(v1, v2)`      | Евклидово расстояние.              |
| `knnInnerProductSimilarity(v1, v2)` | Скалярное произведение (близость). |

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

## YQL-скрипты

Хелпер `yqlScript` позволяет объединять несколько команд, прагм и параметров в один атомарный блок выполнения.

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

- `pragma(name, value)`: установка настроек выполнения.
- `declareParam(name, type)`: явное объявление типов параметров YQL.
- `defineAction(name, params, statements)`: создание переиспользуемых макросов.
- `doAction(name, args)`: вызов определенных действий.
