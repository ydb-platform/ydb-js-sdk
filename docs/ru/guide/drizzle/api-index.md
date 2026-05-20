---
title: Drizzle Adapter — Публичный API
---

# Публичный API

На этой странице перечислены основные публичные экспорты пакета `@ydbjs/drizzle-adapter`.

## Подключение и база данных

Корневые runtime-имена:

- `createDrizzle(input, config?)` и `drizzle(input, config?)` создают объект базы данных.
- `YdbDriver` — исполнитель по умолчанию, использующий `@ydbjs/core` и `@ydbjs/query`.
- Классы ошибок: `YdbQueryExecutionError` (базовый класс для всех ошибок запросов), `YdbUniqueConstraintViolationError`, `YdbAuthenticationError`, `YdbCancelledQueryError`, `YdbTimeoutQueryError`, `YdbUnavailableQueryError`, `YdbOverloadedQueryError`, `YdbRetryableQueryError`.
- Экспортируемые типы: `YdbDrizzleDatabase`, `YdbDrizzleOptions`, `YdbExecutor`, `YdbTransactionalExecutor` и конфигурация транзакций.

Внутренние классы — диалект, сессия, транзакция и конкретные builder'ы — намеренно не экспортируются из корня. Стабильная runtime-поверхность — объект базы данных, возвращаемый `createDrizzle()`.

Преобразованные ошибки YDB содержат `kind`, `retryable`, `statusCode` и исходные диагностические поля вроде `code`, `status`, `issues`, если драйвер их передал.

## Таблицы и схема

- `ydbTable`, `ydbTableCreator`
- `primaryKey`
- `unique`
- `relations`, `one`, `many`
- `index`, `uniqueIndex`, `vectorIndex`
- `indexView`, `vectorIndexView`
- `tableOptions`, `rawTableOption`
- `ttl`
- `partitionByHash`
- `columnFamily`

## Построители колонок

`integer`, `int`, `text`, `bigint`, `boolean`, `bytes`, `binary`, `date`, `date32`, `datetime`, `datetime64`, `decimal`, `double`, `dyNumber`, `float`, `int8`, `int16`, `interval`, `interval64`, `json`, `jsonDocument`, `timestamp`, `timestamp64`, `uint8`, `uint16`, `uint32`, `uint64`, `uuid`, `yson` и `customType`.

## Построители запросов

Точки входа базы данных:

- SELECT: `db.select`, `db.selectDistinct`, `db.selectDistinctOn`, `db.with`, `db.$with`
- Мутации: `db.insert`, `db.upsert`, `db.replace`, `db.update`, `db.batchUpdate`, `db.delete`, `db.batchDelete`
- Утилиты: `db.execute`, `db.all`, `db.get`, `db.values`, `db.$count`, `db.transaction`

Методы builder'ов:

- SELECT-источники: `.from()`, `.fromAsTable()`, `.fromValues()`
- SELECT-предложения: `.where()`, `.having()`, `.groupBy()`, `.groupCompactBy()`, `.orderBy()`, `.assumeOrderBy()`, `.limit()`, `.offset()`
- Расширения SELECT для YDB: `.without()`, `.flattenBy()`, `.flattenListBy()`, `.flattenDictBy()`, `.flattenOptionalBy()`, `.flattenColumns()`, `.sample()`, `.tableSample()`, `.matchRecognize()`, `.window()`, `.intoResult()`, `.uniqueDistinct()`, `.distinct()`, `.distinctOn()`
- JOIN'ы: `.innerJoin()`, `.leftJoin()`, `.rightJoin()`, `.fullJoin()`, `.crossJoin()`, `.leftSemiJoin()`, `.rightSemiJoin()`, `.leftOnlyJoin()`, `.rightOnlyJoin()`, `.exclusionJoin()`
- Операторы множеств: `.union()`, `.unionAll()`, `.intersect()`, `.except()`, `union()`, `unionAll()`, `intersect()`, `except()`
- Мутации: `.values()`, `.select()`, `.set()`, `.where()`, `.using()`, `.on()`, `.returning()`, `.onDuplicateKeyUpdate()`
- Выполнение и рендеринг: `.getSQL()`, `.toSQL()`, `.prepare()`, `.execute()`, `.all()`, `.get()`, `.values()`
- Утилиты доступны через методы базы данных, например `db.$count()`, и через callback-builder'ы, передаваемые в `.select()`, `.on()` и mutation-хелперы.

## YQL-хелперы

- Источники: `asTable`, `values`, `valuesTable`
- Скрипты: `yqlScript`, `pragma`, `declareParam`, `commit`, `defineAction`, `doAction`, `doBlock`, `intoResult`
- Группировка: `rollup`, `cube`, `groupingSets`, `grouping`, `groupKey`
- Окна: `windowDefinition`, `sessionWindow`, `sessionStart`, `hop`, `hopStart`, `hopEnd`
- Векторный поиск: `knnDistance`, `knnSimilarity`, `knnCosineDistance`, `knnEuclideanDistance`, `knnManhattanDistance`, `knnCosineSimilarity`, `knnInnerProductSimilarity`, `kMeansTreeSearchTopSize`
- Сопоставление с шаблоном и хинты: `matchRecognize`, `uniqueHint`, `distinctHint`
- Операторы множеств: `union`, `unionAll`, `intersect`, `except`

## Миграции и DDL

- `migrate`
- Метаданные миграций: `buildMigrationSql`, `buildMigrationLockTableBootstrapSql`
- Таблицы: `buildCreateTableSql`, `buildDropTableSql`, `buildAlterTableSql`, `buildRenameTableSql`, `buildAnalyzeSql`, `buildShowCreateSql`
- Колонки и семейства: `buildAddColumnsSql`, `buildDropColumnsSql`, `buildAddColumnFamilySql`, `buildAlterColumnFamilySql`, `buildAlterColumnSetFamilySql`
- Опции таблиц: `buildAlterTableSetOptionsSql`, `buildAlterTableResetOptionsSql`
- Индексы и CDC: `buildAddIndexSql`, `buildDropIndexSql`, `buildAddChangefeedSql`, `buildDropChangefeedSql`
- Топики: `buildCreateTopicSql`, `buildAlterTopicSql`, `buildDropTopicSql`
- Пользователи и группы: `buildCreateUserSql`, `buildAlterUserSql`, `buildDropUserSql`, `buildCreateGroupSql`, `buildAlterGroupSql`, `buildDropGroupSql`
- ACL: `buildGrantSql`, `buildRevokeSql`
- Представления: `buildCreateViewSql`, `buildDropViewSql`
- Сервисы: `buildCreateAsyncReplicationSql`, `buildAlterAsyncReplicationSql`, `buildDropAsyncReplicationSql`, `buildCreateTransferSql`, `buildAlterTransferSql`, `buildDropTransferSql`, `buildCreateSecretSql`
