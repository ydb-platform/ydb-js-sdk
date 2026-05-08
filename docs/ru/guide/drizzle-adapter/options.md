---
title: Drizzle Adapter — Опции и API
---

# Опции и API `@ydbjs/drizzle-adapter`

Ниже представлен полный обзор конфигурации адаптера, методов выполнения и доступных опций.

## Клиент и базовый синтаксис

```ts
import { createDrizzle } from '@ydbjs/drizzle-adapter'

let db = createDrizzle({
  connectionString: process.env['YDB_CONNECTION_STRING']!,
  schema,
  logger: true,
})
```

Опции клиента:

- `connectionString`: создает собственный `YdbDriver` на основе строки подключения.
- `client`: существующий `YdbExecutor` или `YdbTransactionalExecutor`.
- `schema`: включает типизированный Relational Query API (`db.query.*`).
- `logger`: `true`, `false` или кастомный логгер Drizzle.
- `casing`: режим именования Drizzle (`'snake_case'` или `'camelCase'`) для диалекта.

Альтернативные способы инициализации:

- `createDrizzle(executor, config?)`: использование существующего исполнителя.
- `createDrizzle(callback, config?)`: использование удаленного callback-исполнителя (режим Proxy).
- `drizzle(...)`: алиас для `createDrizzle(...)`.

## Методы базы данных

- `execute(query)`: выполняет запрос и возвращает типизированный результат.
- `all(query)`: возвращает все строки в виде массива объектов.
- `get(query)`: возвращает первую строку или `undefined`.
- `values(query)`: возвращает строки в виде массивов значений.
- `transaction(callback, config?)`: выполняет callback внутри транзакции YDB.
- `$count(source, filters?)`: вспомогательный метод для эффективного подсчета строк.
- `$client`: базовый исполнитель; используйте `ready?.()` и `close?.()` для управления жизненным циклом.

Опции транзакции:

- `accessMode`: `'read write' | 'read only'`.
- `isolationLevel`: `'serializableReadWrite' | 'snapshotReadOnly'`.
- `idempotent`: если `true`, адаптер сможет автоматически перезапустить транзакцию при сетевых ошибках.

## Опции схемы

- `ydbTable(name, columns, extraConfig?)`: объявление таблицы.
- `ydbTableCreator(customizeTableName)`: фабрика таблиц с маппингом имен.
- `primaryKey({ columns })`: составной первичный ключ.
- `unique(name?).on(...columns)`: ограничение уникальности.
- `index(name?).on(...columns)`: вторичный индекс.
- `uniqueIndex(name?).on(...columns)`: уникальный вторичный индекс.
- `vectorIndex(name, options).on(column)`: векторный индекс.
- `tableOptions(options)`: сырые опции таблицы YDB.
- `ttl(column, intervalOrActions, options?)`: конфигурация TTL (время жизни данных).
- `partitionByHash(...columns)`: партиционирование по хешу.
- `columnFamily(name, options?).columns(...columns)`: семейства колонок.

Опции построителя индексов:

- `.global()` / `.local()`: область видимости индекса.
- `.sync()` / `.async()`: синхронность записи.
- `.using(indexType)`: пользовательский тип индекса.
- `.vectorKMeansTree(options)`: тип индекса vector k-means tree.
- `.cover(...columns)`: покрывающие колонки.
- `.with(options)`: сырые опции индекса.

Опции векторного индекса:

- `vectorDimension`, `vectorType`, `distance` или `similarity`, `clusters`, `levels`.

## Опции построителя запросов

SELECT:

- Источники: `.from()`, `.fromAsTable()`, `.fromValues()`.
- Фильтрация и группировка: `.where()`, `.having()`, `.groupBy()`, `.groupCompactBy()`.
- Сортировка и лимиты: `.orderBy()`, `.assumeOrderBy()`, `.limit()`, `.offset()`.
- Расширения YDB: `.without()`, `.flattenBy()`, `.flattenListBy()`, `.flattenDictBy()`, `.flattenOptionalBy()`, `.flattenColumns()`, `.sample()`, `.tableSample()`, `.matchRecognize()`, `.window()`, `.intoResult()`.
- Distinct и операции над множествами: `.distinct()`, `.distinctOn()`, `.uniqueDistinct()`, `.union()`, `.unionAll()`, `.intersect()`, `.except()`.
- Выполнение и рендеринг: `.getSQL()`, `.toSQL()`, `.execute()`, `.prepare()`. Prepared queries дают `.all()`, `.get()` и `.values()`.

Мутации:

- Insert-построители: `.values()`, `.select()`, `.onDuplicateKeyUpdate()`, `.returning()`.
- Update-построители: `.set()`, `.where()`, `.on()`, `.returning()`.
- Delete-построители: `.where()`, `.using()`, `.on()`, `.returning()`.
- Batch-построители: `batchUpdate` и `batchDelete` поддерживают `.where()`, но не принимают `returning()` и `on()`.

## Опции Relational Query

Используйте `db.query.<table>.findFirst(config?)` и `db.query.<table>.findMany(config?)`, если передана `schema`.

- `columns`: включение или исключение конкретных колонок.
- `where`: callback с логикой фильтрации.
- `orderBy`: callback с выражениями сортировки.
- `limit` и `offset`: управление пагинацией.
- `with`: загрузка вложенных связей.
- `extras`: дополнительные SQL-выборки.

## Опции миграций

- `migrationsFolder`: путь к папке с миграциями Drizzle.
- `migrations`: инлайновые объекты миграций.
- `migrationsTable`: имя таблицы истории миграций.
- `migrationsSchema`: схема или префикс папки для таблиц истории.
- `migrationsLockTable`: имя таблицы блокировок.
- `migrationLock`: `true`, `false` или опции блокировки.
- `migrationRecovery`: опции восстановления.

Опции блокировки:

- `key`, `ownerId`, `leaseMs`, `acquireTimeoutMs`, `retryIntervalMs`.

Опции восстановления:

- `mode`: `'fail' | 'retry'`.
- `staleRunningAfterMs`: порог времени для признания миграции зависшей.

## Опции YQL-хелперов

- `valuesTable(rows, { alias?, columns? })`: инлайновый источник данных.
- `windowDefinition({ partitionBy?, orderBy?, frame? })`: конфигурация окна.
- `matchRecognize({ partitionBy?, orderBy?, measures?, rowsPerMatch?, afterMatchSkip?, pattern, define? })`: поиск паттернов в событиях.
- `pragma(name, value?)`, `declareParam(name, dataType)`, `defineAction(name, params, statements)`, `doAction(name, args?)`: хелперы для YQL-скриптов.
- `kMeansTreeSearchTopSize(value)`: хелпер для прагмы векторного поиска.

## Ограничения

- Адаптер ESM-only, как и остальные пакеты YDB JavaScript SDK.
- Вложенные YDB-транзакции не поддерживаются. Создавайте одну границу транзакции и передавайте объект `tx` в нижние уровни.
- Поддерживаются режимы транзакций `serializableReadWrite` и `snapshotReadOnly`; неподдерживаемые уровни изоляции не эмулируются.
- `references()` является только metadata для relations. YDB не enforcing foreign keys.
- Уникальные индексы нужно создавать через DDL таблицы; добавление unique index к существующей таблице отклоняется.
- Raw helpers (`sql.raw`, inline migration `sql`, `rawTableOption`, текст view query, raw ACL permissions, transfer `using`) намеренно обходят экранирование и не должны получать недоверенный ввод.
