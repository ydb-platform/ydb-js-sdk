---
title: Drizzle Adapter — Схема данных
---

# Описание схемы

Адаптер YDB для Drizzle предоставляет специализированный DSL для описания таблиц, поддерживающий все специфичные возможности YDB, такие как TTL, партиционирование и специализированные индексы.

## Описание таблицы

Для создания таблицы используйте функцию `ydbTable`. В YDB наличие **первичного ключа (Primary Key) обязательно**.

```ts
import { integer, text, ydbTable } from '@ydbjs/drizzle-adapter'

export const users = ydbTable('users', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
})
```

### Структура ydbTable

1. **Имя таблицы** (`string`): Имя таблицы в базе данных.
2. **Колонки** (`object`): Описание структуры колонок.
3. **Extra Config** (`callback`, опционально): Функция для настройки индексов, ограничений и специфичных опций YDB.

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

### Кастомизация имен таблиц

Используйте `ydbTableCreator` для добавления глобального префикса или трансформации имен всех таблиц.

```ts
import { ydbTableCreator } from '@ydbjs/drizzle-adapter'

const appTable = ydbTableCreator((name) => `myapp/${name}`)

export const users = appTable('users', {
  /* ... */
})
```

## Типы данных

Адаптер экспортирует строители для всех примитивных и составных типов YDB.

### Примитивные типы

| Функция         | Тип YDB  | Тип TS    | Описание                  |
| :-------------- | :------- | :-------- | :------------------------ |
| `boolean(name)` | `Bool`   | `boolean` | Логическое значение       |
| `int8(name)`    | `Int8`   | `number`  | 8-бит со знаком           |
| `uint8(name)`   | `Uint8`  | `number`  | 8-бит без знака           |
| `int16(name)`   | `Int16`  | `number`  | 16-бит со знаком          |
| `uint16(name)`  | `Uint16` | `number`  | 16-бит без знака          |
| `integer(name)` | `Int32`  | `number`  | 32-бит со знаком          |
| `uint32(name)`  | `Uint32` | `number`  | 32-бит без знака          |
| `bigint(name)`  | `Int64`  | `bigint`  | 64-бит со знаком          |
| `uint64(name)`  | `Uint64` | `bigint`  | 64-бит без знака          |
| `float(name)`   | `Float`  | `number`  | 32-бит с плавающей точкой |
| `double(name)`  | `Double` | `number`  | 64-бит с плавающей точкой |

### Строки и бинарные данные

| Функция                 | Тип YDB        | Тип TS       | Описание                         |
| :---------------------- | :------------- | :----------- | :------------------------------- |
| `text(name)`            | `Utf8`         | `string`     | Unicode строка                   |
| `bytes(name)`           | `String`       | `Uint8Array` | Бинарные данные                  |
| `uuid(name)`            | `Uuid`         | `string`     | Строка UUID                      |
| `yson(name)`            | `Yson`         | `Uint8Array` | Формат YSON                      |
| `json<T>(name)`         | `Json`         | `T`          | JSON текст                       |
| `jsonDocument<T>(name)` | `JsonDocument` | `T`          | Бинарный JSON (оптимизированный) |

### Дата и время

| Функция             | Тип YDB       | Тип TS   | Описание                              |
| :------------------ | :------------ | :------- | :------------------------------------ |
| `date(name)`        | `Date`        | `Date`   | Только дата (до 2038 г.)              |
| `date32(name)`      | `Date32`      | `Date`   | Дата с расширенным диапазоном         |
| `datetime(name)`    | `Datetime`    | `Date`   | Дата и время (до 2038 г.)             |
| `datetime64(name)`  | `Datetime64`  | `Date`   | Дата и время (расширенный диапазон)   |
| `timestamp(name)`   | `Timestamp`   | `Date`   | Микросекундная точность (до 2038 г.)  |
| `timestamp64(name)` | `Timestamp64` | `Date`   | Микросекундная точность (расширенный) |
| `interval(name)`    | `Interval`    | `number` | Интервал в микросекундах              |

### Замечания по маппингу

- YDB `String` в адаптере означает бинарные данные и маппится в `Uint8Array` через `bytes()` или `binary()`.
- Для человекочитаемого текста используйте YDB `Utf8` через `text()`.
- `Int64` и `Uint64` маппятся в `bigint`, чтобы не терять точность.
- Date/time builders маппятся в JavaScript `Date`; адаптер конвертирует значения на границе драйвера.
- `json<T>()` и `jsonDocument<T>()` возвращают типизированные JSON-значения. Generic нужен для фиксации ожидаемой формы.

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

## Модификаторы колонок

- `.primaryKey()`: Делает колонку частью первичного ключа.
- `.notNull()`: Запрещает `NULL`.
- `.default(value)`: Статическое значение по умолчанию.
- `.$defaultFn(() => value)`: Динамическое значение по умолчанию.
- `.unique(name?)`: Создает вторичный уникальный индекс.
- `.references(() => column)`: Метаданные для Relational Query API (YDB не поддерживает нативные Foreign Keys).

## Первичные ключи (Primary Keys)

YDB требует наличия первичного ключа для каждой таблицы.

### Одиночная колонка

```ts
id: integer('id').primaryKey()
```

### Составной ключ (Уровень таблицы)

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

## Вторичные индексы

Вторичные индексы в YDB хранятся как отдельные внутренние таблицы.

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

- `.global()` / `.local()`: Область видимости индекса (Global по умолчанию).
- `.sync()` / `.async()`: Режим синхронизации записи.
- `.cover(...columns)`: Добавление колонок в индекс (Covering Index).

## Векторные индексы

YDB поддерживает специализированные индексы для векторного поиска (AI/ML).

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

## Настройки таблицы

### Физические параметры

```ts
import { tableOptions } from '@ydbjs/drizzle-adapter'

tableOptions({
  AUTO_PARTITIONING_BY_LOAD: 'ENABLED',
  KEY_BLOOM_FILTER: 'ENABLED',
})
```

### Время жизни данных (TTL)

Автоматическое удаление устаревших данных.

```ts
import { ttl } from '@ydbjs/drizzle-adapter'

ttl(table.createdAt, 'P30D') // Удалить через 30 дней
ttl(table.expireAt, '3600', { unit: 'SECONDS' })
```

### Партиционирование

```ts
import { partitionByHash } from '@ydbjs/drizzle-adapter'

partitionByHash(table.tenantId)
```

### Семейства колонок

```ts
import { columnFamily } from '@ydbjs/drizzle-adapter'

columnFamily('cold_data', {
  data: 'rot',
  compression: 'zstd',
}).columns(table.bio)
```
