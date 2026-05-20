---
title: Drizzle Adapter — Построители запросов
---

# Построители запросов

Адаптер YDB для Drizzle расширяет стандартный синтаксис Drizzle для поддержки специфичных возможностей YDB и нативных операторов YQL.

Сквозные примеры, где эти построители используются вместе, собраны в разделе [Примеры Drizzle Adapter](/ru/guide/drizzle-adapter/examples).

## Построитель SELECT

`YdbSelectBuilder` — основной инструмент для выборки данных.

### Точки входа

```ts
db.select() // SELECT *
db.select({ id: users.id, name: users.name }) // Выборочные колонки
db.selectDistinct({ name: users.name }) // SELECT DISTINCT
db.selectDistinctOn([users.name], { id: users.id }) // SELECT DISTINCT ON (...)
```

### Fluent API и расширения YDB

Помимо стандартных методов Drizzle (`where`, `orderBy`, `limit` и др.), адаптер предоставляет:

- `.fromAsTable(binding, alias?)`: использование источника `AS_TABLE`.
- `.fromValues(rows, options?)`: использование инлайновых значений как источника.
- `.without(...columns)`: исключение конкретных колонок из `SELECT *`.
- `.groupCompactBy(...columns)`: оптимизированная группировка для отсортированных данных.
- `.assumeOrderBy(...columns)`: подсказка оптимизатору, что вход уже отсортирован.
- `.sample(ratio)` / `.tableSample(method, size)`: выборка случайной доли данных.
- `.window(name, definition)`: объявление именованных окон.
- `.intoResult(name)`: вывод результата в именованный блок YDB.
- `.flattenBy()`, `.flattenListBy()`: операторы YQL `FLATTEN`.

Пример:

```ts
const rows = await db
  .select()
  .from(users)
  .without(users.password)
  .where(eq(users.active, true))
  .limit(10)
  .execute()
```

## JOIN (Объединение таблиц)

Адаптер поддерживает 10 типов объединений, включая специфичные для YDB semi-joins:

| Стандартные JOIN | Полу-соединения (Semi-JOINs) YDB                                          |
| :--------------- | :------------------------------------------------------------------------ |
| `.innerJoin()`   | `.leftSemiJoin()`: строки слева, имеющие соответствие справа.             |
| `.leftJoin()`    | `.rightSemiJoin()`: строки справа, имеющие соответствие слева.            |
| `.rightJoin()`   | `.leftOnlyJoin()`: строки слева **без** соответствия (аналог NOT EXISTS). |
| `.fullJoin()`    | `.rightOnlyJoin()`: строки справа **без** соответствия.                   |
| `.crossJoin()`   | `.exclusionJoin()`: строки без соответствия в противоположной таблице.    |

```ts
const inactiveUsers = await db
  .select()
  .from(users)
  .leftOnlyJoin(posts, eq(users.id, posts.authorId))
  .execute()
```

## Мутации (Изменение данных)

### INSERT, UPSERT и REPLACE

YDB предлагает эффективные способы управления данными по первичному ключу.

- `.insert(table)`: обычный `INSERT INTO`.
- `.upsert(table)`: `UPSERT INTO` — самый эффективный способ «вставить или обновить» по PK.
- `.replace(table)`: `REPLACE INTO` — полная замена строки по PK; колонки, которых нет в `.values()`, рендерятся как `DEFAULT`.

```ts
await db.upsert(users).values({ id: 1, name: 'Alice' }).execute()
await db.replace(users).values({ id: 1, name: 'Replaced' }).execute()
```

Используйте `upsert()`, когда retryable writer должен создать строку или обновить только переданные колонки:

```ts
await db
  .upsert(users)
  .values({
    id: 42,
    name: 'Ada',
    updatedAt: new Date(),
  })
  .execute()
```

Используйте `replace()`, когда строка является полным snapshot и дефолты для пропущенных колонок ожидаемы:

```ts
await db
  .replace(users)
  .values({
    id: 42,
    name: 'Ada Lovelace',
    updatedAt: new Date(),
  })
  .execute()
```

### UPDATE и DELETE

- `.update(table)`: частичное обновление колонок.
- `.delete(table)`: удаление строк.

Адаптер также поддерживает **Update с подзапросом** (`.on()`) и **Delete с USING**:

```ts
await db
  .update(users)
  .on((qb) =>
    qb
      .select({ id: users.id, name: sql`'New Name'`.as('name') })
      .from(users)
      .where(eq(users.status, 'active'))
  )
  .execute()
```

## CTE ($with)

Common Table Expressions в YDB рендерятся как переменные-биндинги.

```ts
const activeUsers = db
  .$with('active_users')
  .as(db.select().from(users).where(eq(users.active, true)))

const rows = await db.with(activeUsers).select().from(activeUsers).execute()
```

## Подготовленные запросы (Prepared Queries)

Используйте `.prepare()` для часто выполняемых запросов, чтобы сэкономить на парсинге и планировании.

```ts
const selectUser = db
  .select()
  .from(users)
  .where(eq(users.id, sql.placeholder('id')))
  .prepare()

const user = await selectUser.execute({ id: 1 })
```

Построители выполняются через `.execute()`. Prepared queries дополнительно дают `.all()`, `.get()` и `.values()`.

```ts
const prepared = db.select({ id: users.id, name: users.name }).from(users).prepare('users')

const rows = await prepared.all()
const first = await prepared.get()
const values = await prepared.values()
```
