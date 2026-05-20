---
title: Drizzle Adapter — Public API
---

# Public API Index

This page lists the primary public exports of `@ydbjs/drizzle-adapter`.

## Connection and Database

Root runtime names:

- `createDrizzle(input, config?)` and `drizzle(input, config?)` create the database object.
- `YdbDriver` is the default executor backed by `@ydbjs/core` and `@ydbjs/query`.
- Error classes: `YdbUniqueConstraintViolationError`, `YdbAuthenticationError`, `YdbCancelledQueryError`, `YdbTimeoutQueryError`, `YdbUnavailableQueryError`, `YdbOverloadedQueryError`, and `YdbRetryableQueryError`.
- Type exports cover `YdbDrizzleDatabase`, `YdbDrizzleOptions`, `YdbExecutor`, `YdbTransactionalExecutor`, and transaction configuration.

Implementation classes such as the dialect, session, transaction, and concrete builders are intentionally not root runtime exports. The stable runtime surface is the database object returned by `createDrizzle()`.

Mapped YDB query errors expose `kind`, `retryable`, `statusCode`, and original diagnostic fields such as `code`, `status`, and `issues` when the driver provides them.

## Tables and Schema

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

## Column Builders

`integer`, `int`, `text`, `bigint`, `boolean`, `bytes`, `binary`, `date`, `date32`, `datetime`, `datetime64`, `decimal`, `double`, `dyNumber`, `float`, `int8`, `int16`, `interval`, `interval64`, `json`, `jsonDocument`, `timestamp`, `timestamp64`, `uint8`, `uint16`, `uint32`, `uint64`, `uuid`, `yson`, and `customType`.

## Query Builders

Database entry points:

- SELECT: `db.select`, `db.selectDistinct`, `db.selectDistinctOn`, `db.with`, `db.$with`
- Mutations: `db.insert`, `db.upsert`, `db.replace`, `db.update`, `db.batchUpdate`, `db.delete`, `db.batchDelete`
- Utilities: `db.execute`, `db.all`, `db.get`, `db.values`, `db.$count`, `db.transaction`

Builder methods:

- SELECT sources: `.from()`, `.fromAsTable()`, `.fromValues()`
- SELECT clauses: `.where()`, `.having()`, `.groupBy()`, `.groupCompactBy()`, `.orderBy()`, `.assumeOrderBy()`, `.limit()`, `.offset()`
- YDB SELECT extensions: `.without()`, `.flattenBy()`, `.flattenListBy()`, `.flattenDictBy()`, `.flattenOptionalBy()`, `.flattenColumns()`, `.sample()`, `.tableSample()`, `.matchRecognize()`, `.window()`, `.intoResult()`, `.uniqueDistinct()`, `.distinct()`, `.distinctOn()`
- Joins: `.innerJoin()`, `.leftJoin()`, `.rightJoin()`, `.fullJoin()`, `.crossJoin()`, `.leftSemiJoin()`, `.rightSemiJoin()`, `.leftOnlyJoin()`, `.rightOnlyJoin()`, `.exclusionJoin()`
- Set operators: `.union()`, `.unionAll()`, `.intersect()`, `.except()`, `union()`, `unionAll()`, `intersect()`, `except()`
- Mutations: `.values()`, `.select()`, `.set()`, `.where()`, `.using()`, `.on()`, `.returning()`, `.onDuplicateKeyUpdate()`
- Execution and rendering: `.getSQL()`, `.toSQL()`, `.prepare()`, `.execute()`, `.all()`, `.get()`, `.values()`
- Utilities are exposed through database methods such as `db.$count()` and callback builders passed to `.select()`, `.on()`, and mutation helpers.

## YQL Helpers

- Sources: `asTable`, `values`, `valuesTable`
- Scripts: `yqlScript`, `pragma`, `declareParam`, `commit`, `defineAction`, `doAction`, `doBlock`, `intoResult`
- Grouping: `rollup`, `cube`, `groupingSets`, `grouping`, `groupKey`
- Windows: `windowDefinition`, `sessionWindow`, `sessionStart`, `hop`, `hopStart`, `hopEnd`
- Vector search: `knnDistance`, `knnSimilarity`, `knnCosineDistance`, `knnEuclideanDistance`, `knnManhattanDistance`, `knnCosineSimilarity`, `knnInnerProductSimilarity`, `kMeansTreeSearchTopSize`
- Pattern matching and hints: `matchRecognize`, `uniqueHint`, `distinctHint`
- Set operators: `union`, `unionAll`, `intersect`, `except`

## Migrations and DDL

- `migrate`
- Migration metadata: `buildMigrationSql`, `buildMigrationLockTableBootstrapSql`
- Tables: `buildCreateTableSql`, `buildDropTableSql`, `buildAlterTableSql`, `buildRenameTableSql`, `buildAnalyzeSql`, `buildShowCreateSql`
- Columns and families: `buildAddColumnsSql`, `buildDropColumnsSql`, `buildAddColumnFamilySql`, `buildAlterColumnFamilySql`, `buildAlterColumnSetFamilySql`
- Table options: `buildAlterTableSetOptionsSql`, `buildAlterTableResetOptionsSql`
- Indexes and CDC: `buildAddIndexSql`, `buildDropIndexSql`, `buildAddChangefeedSql`, `buildDropChangefeedSql`
- Topics: `buildCreateTopicSql`, `buildAlterTopicSql`, `buildDropTopicSql`
- Users and groups: `buildCreateUserSql`, `buildAlterUserSql`, `buildDropUserSql`, `buildCreateGroupSql`, `buildAlterGroupSql`, `buildDropGroupSql`
- ACL: `buildGrantSql`, `buildRevokeSql`
- Views: `buildCreateViewSql`, `buildDropViewSql`
- Services: `buildCreateAsyncReplicationSql`, `buildAlterAsyncReplicationSql`, `buildDropAsyncReplicationSql`, `buildCreateTransferSql`, `buildAlterTransferSql`, `buildDropTransferSql`, `buildCreateSecretSql`
