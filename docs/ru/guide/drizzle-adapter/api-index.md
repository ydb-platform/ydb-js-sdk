---
title: Публичный API
description: Полный список корневых экспортов и публичных методов @ydbjs/drizzle-adapter.
---

Этот файл содержит исчерпывающий список всех публичных имен, экспортируемых пакетом `@ydbjs/drizzle-adapter`.

## Подключение и база данных

- [`createDrizzle`](./database-api#createdrizzle) — инициализация адаптера.
- [`drizzle`](./database-api#createdrizzle) — алиас `createDrizzle`.
- Типы `YdbDrizzleDatabase`, `YdbDrizzleOptions`, `YdbExecutor`, `YdbTransactionalExecutor` и конфигурация транзакций.

## Драйвер и Транспорт

- [`YdbDriver`](./database-api) — основной драйвер.
- Ошибки выполнения: `YdbUniqueConstraintViolationError`, `YdbAuthenticationError`, `YdbCancelledQueryError`, `YdbTimeoutQueryError`, `YdbUnavailableQueryError`, `YdbOverloadedQueryError`, `YdbRetryableQueryError`.

Внутренние классы диалекта, сессии, транзакции и конкретных builders намеренно не являются корневыми runtime-экспортами. Стабильная runtime-поверхность — объект БД, возвращаемый `createDrizzle()`.

Смаппленные ошибки YDB содержат `kind`, `retryable`, `statusCode` и исходные диагностические поля вроде `code`, `status`, `issues`, если драйвер их передал.

## Таблицы и Схема

- [`ydbTable`](./schema) — объявление таблицы.
- [`ydbTableCreator`](./schema#кастомизация-имен-таблиц) — фабрика таблиц с префиксами.
- [`primaryKey`](./schema#первичные-ключи) — составной ПК.
- [`unique`](./schema#вторичные-индексы) — ограничение уникальности.
- [`relations`, `one`, `many`](./database-api#relational-query-api) — описание связей.

## Колонки и Типы (25+ типов)

Подробное описание всех типов: [Колонки и типы](./schema#типы-данных).

- `integer`, `int`, `text`, `bigint`, `boolean`, `bytes`, `binary`, `date`, `date32`, `datetime`, `datetime64`, `decimal`, `double`, `dyNumber`, `float`, `int8`, `int16`, `interval`, `interval64`, `json`, `jsonDocument`, `timestamp`, `timestamp64`, `uint8`, `uint16`, `uint32`, `uint64`, `uuid`, `yson`, `customType`.

## Опции таблиц и TTL

- [`tableOptions`](./schema#настройки-таблицы) — физические параметры.
- [`ttl`](./schema#время-жизни-данных-ttl) — Time To Live.
- [`partitionByHash`](./schema#партиционирование) — шардирование.
- [`columnFamily`](./schema#семейства-колонок) — семейства колонок.
- [`rawTableOption`](./schema#физические-параметры) — сырые опции.

## Индексы и Поиск

- [`index`](./schema#вторичные-индексы) — вторичный индекс.
- [`uniqueIndex`](./schema#вторичные-индексы) — уникальный индекс.
- [`vectorIndex`](./schema#векторные-индексы) — векторный поиск.
- [`indexView`](./yql-helpers) — чтение через индекс.
- [`vectorIndexView`](./yql-helpers) — чтение через векторный индекс.

## Построители запросов (Query Builders)

Подробный гид: [SELECT builder](./query-builders), [Мутации](./query-builders#мутации-изменение-данных).

- **SELECT**: `db.select`, `db.selectDistinct`, `db.selectDistinctOn`, `db.with`, `db.$with`.
- **Мутации**: `db.insert`, `db.upsert`, `db.replace`, `db.update`, `db.batchUpdate`, `db.delete`, `db.batchDelete`.
- **Утилиты**: `db.$count` и callback-builders, передаваемые в `.select()`, `.on()` и mutation helpers.

## Хелперы YQL и Аналитика

Подробная справка: [YQL-хелперы](./yql-helpers).

- **Скрипты**: `yqlScript`, `pragma`, `declareParam`, `commit`, `defineAction`, `doAction`, `doBlock`, `intoResult`.
- **Аналитика**: `rollup`, `cube`, `groupingSets`, `grouping`, `groupKey`, `sessionWindow`, `sessionStart`, `hop`, `hopStart`, `hopEnd`.
- **Векторный поиск (KNN)**: `knnDistance`, `knnSimilarity`, `knnCosineDistance`, `knnEuclideanDistance`, `knnManhattanDistance`, `knnCosineSimilarity`, `knnInnerProductSimilarity`, `kMeansTreeSearchTopSize`.
- **Источники и хинты**: `asTable`, `values`, `valuesTable`, `matchRecognize`, `uniqueHint`, `distinctHint`, `windowDefinition`.

## Миграции и DDL (50+ методов)

Подробно: [Migrator](./migrations-ddl), [DDL-построители](./migrations-ddl#ddl-построители).

- **Core**: `migrate`, `buildMigrationSql`, `buildMigrationLockTableBootstrapSql`.
- **Таблицы**: `buildCreateTableSql`, `buildDropTableSql`, `buildAlterTableSql`, `buildRenameTableSql`.
- **Колонки и CF**: `buildAddColumnsSql`, `buildDropColumnsSql`, `buildAddColumnFamilySql`, `buildAlterColumnFamilySql`, `buildAlterColumnSetFamilySql`.
- **Индексы и CDC**: `buildAddIndexSql`, `buildDropIndexSql`, `buildAddChangefeedSql`, `buildDropChangefeedSql`.
- **Топики**: `buildCreateTopicSql`, `buildAlterTopicSql`, `buildDropTopicSql`.
- **Пользователи и права**: `buildCreateUserSql`, `buildAlterUserSql`, `buildDropUserSql`, `buildGrantSql`, `buildRevokeSql`, `buildCreateGroupSql`, `buildAlterGroupSql`, `buildDropGroupSql`.
- **Сервисы**: `buildCreateAsyncReplicationSql`, `buildAlterAsyncReplicationSql`, `buildDropAsyncReplicationSql`, `buildCreateTransferSql`, `buildAlterTransferSql`, `buildDropTransferSql`, `buildCreateSecretSql`, `buildCreateViewSql`, `buildDropViewSql`, `buildAnalyzeSql`, `buildShowCreateSql`.
