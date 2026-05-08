import { test } from 'vitest'
import assert from 'node:assert/strict'
import * as publicApi from '../../src/index.ts'
import { createMany, createOne, relations } from 'drizzle-orm'
import * as queryBuilders from '../../src/ydb-core/query-builders/index.ts'
import { YdbCountBuilder } from '../../src/ydb-core/query-builders/count.ts'
import {
	YdbBatchDeleteBuilder,
	YdbDeleteBuilder,
} from '../../src/ydb-core/query-builders/delete.ts'
import {
	YdbInsertBuilder,
	YdbReplaceBuilder,
	YdbUpsertBuilder,
} from '../../src/ydb-core/query-builders/insert.ts'
import { YdbQueryBuilder } from '../../src/ydb-core/query-builders/query-builder.ts'
import {
	YdbRelationalQuery,
	YdbRelationalQueryBuilder,
} from '../../src/ydb-core/query-builders/query.ts'
import {
	YdbSelectBuilder,
	except,
	intersect,
	union,
	unionAll,
} from '../../src/ydb-core/query-builders/select.ts'
import {
	YdbBatchUpdateBuilder,
	YdbUpdateBuilder,
} from '../../src/ydb-core/query-builders/update.ts'
import {
	YdbAuthenticationError,
	YdbCancelledQueryError,
	YdbOverloadedQueryError,
	YdbQueryExecutionError,
	YdbRetryableQueryError,
	YdbTimeoutQueryError,
	YdbUnavailableQueryError,
	YdbUniqueConstraintViolationError,
} from '../../src/ydb/errors.ts'
import { ydbTable } from '../../src/ydb-core/table.ts'
import {
	buildAddChangefeedSql,
	buildAddColumnFamilySql,
	buildAlterAsyncReplicationSql,
	buildAlterColumnFamilySql,
	buildAlterColumnSetFamilySql,
	buildAlterGroupSql,
	buildAlterTableResetOptionsSql,
	buildAlterTableSetOptionsSql,
	buildAlterTableSql,
	buildAlterTopicSql,
	buildAlterTransferSql,
	buildAlterUserSql,
	buildAnalyzeSql,
	buildCreateAsyncReplicationSql,
	buildCreateGroupSql,
	buildCreateSecretSql,
	buildCreateTableSql,
	buildCreateTopicSql,
	buildCreateTransferSql,
	buildCreateUserSql,
	buildCreateViewSql,
	buildDropAsyncReplicationSql,
	buildDropChangefeedSql,
	buildDropGroupSql,
	buildDropTopicSql,
	buildDropTransferSql,
	buildDropUserSql,
	buildDropViewSql,
	buildGrantSql,
	buildMigrationLockTableBootstrapSql,
	buildRenameTableSql,
	buildRevokeSql,
	buildShowCreateSql,
} from '../../src/ydb/migration-ddl.ts'
import { migrate } from '../../src/ydb/migrator.ts'
import { customType } from '../../src/ydb-core/columns/custom.ts'
import { integer } from '../../src/ydb-core/columns/integer.ts'
import { text } from '../../src/ydb-core/columns/text.ts'
import {
	index,
	indexView,
	uniqueIndex,
	vectorIndex,
	vectorIndexView,
} from '../../src/ydb-core/indexes.ts'
import {
	bigint,
	binary,
	boolean,
	bytes,
	date,
	date32,
	datetime,
	datetime64,
	decimal,
	double,
	dyNumber,
	float,
	int16,
	int8,
	interval,
	interval64,
	json,
	jsonDocument,
	timestamp,
	timestamp64,
	uint16,
	uint32,
	uint64,
	uint8,
	uuid,
	yson,
} from '../../src/ydb-core/columns/types.ts'
import { primaryKey } from '../../src/ydb-core/primary-keys.ts'
import {
	columnFamily,
	partitionByHash,
	rawTableOption,
	tableOptions,
	ttl,
} from '../../src/ydb-core/table-options.ts'
import { unique } from '../../src/ydb-core/unique-constraint.ts'
import { createDrizzle, drizzle } from '../../src/ydb/createDrizzle.ts'
import { YdbDriver } from '../../src/ydb/driver.ts'
import {
	asTable,
	cube,
	distinctHint,
	groupKey,
	grouping,
	groupingSets,
	hop,
	hopEnd,
	hopStart,
	knnCosineDistance,
	knnCosineSimilarity,
	knnDistance,
	knnEuclideanDistance,
	knnInnerProductSimilarity,
	knnManhattanDistance,
	knnSimilarity,
	matchRecognize,
	rollup,
	sessionStart,
	sessionWindow,
	uniqueHint,
	values,
	valuesTable,
	windowDefinition,
} from '../../src/ydb-core/query-builders/select-syntax.ts'
import {
	commit,
	declareParam,
	defineAction,
	doAction,
	doBlock,
	intoResult,
	kMeansTreeSearchTopSize,
	pragma,
	yqlScript,
} from '../../src/ydb-core/query-builders/yql-script.ts'

let expectedRootRuntimeExports = [
	'YdbAuthenticationError',
	'YdbCancelledQueryError',
	'YdbDriver',
	'YdbOverloadedQueryError',
	'YdbQueryExecutionError',
	'YdbRetryableQueryError',
	'YdbTimeoutQueryError',
	'YdbUnavailableQueryError',
	'YdbUniqueConstraintViolationError',
	'asTable',
	'bigint',
	'binary',
	'boolean',
	'buildAddChangefeedSql',
	'buildAddColumnFamilySql',
	'buildAddColumnsSql',
	'buildAddIndexSql',
	'buildAlterAsyncReplicationSql',
	'buildAlterColumnFamilySql',
	'buildAlterColumnSetFamilySql',
	'buildAlterGroupSql',
	'buildAlterTableResetOptionsSql',
	'buildAlterTableSetOptionsSql',
	'buildAlterTableSql',
	'buildAlterTopicSql',
	'buildAlterTransferSql',
	'buildAlterUserSql',
	'buildAnalyzeSql',
	'buildCreateAsyncReplicationSql',
	'buildCreateGroupSql',
	'buildCreateSecretSql',
	'buildCreateTableSql',
	'buildCreateTopicSql',
	'buildCreateTransferSql',
	'buildCreateUserSql',
	'buildCreateViewSql',
	'buildDropAsyncReplicationSql',
	'buildDropChangefeedSql',
	'buildDropColumnsSql',
	'buildDropGroupSql',
	'buildDropIndexSql',
	'buildDropTableSql',
	'buildDropTopicSql',
	'buildDropTransferSql',
	'buildDropUserSql',
	'buildDropViewSql',
	'buildGrantSql',
	'buildMigrationLockTableBootstrapSql',
	'buildMigrationSql',
	'buildRenameTableSql',
	'buildRevokeSql',
	'buildShowCreateSql',
	'bytes',
	'columnFamily',
	'commit',
	'createDrizzle',
	'cube',
	'customType',
	'date',
	'date32',
	'datetime',
	'datetime64',
	'decimal',
	'declareParam',
	'defineAction',
	'distinctHint',
	'doAction',
	'doBlock',
	'double',
	'drizzle',
	'dyNumber',
	'except',
	'float',
	'groupKey',
	'grouping',
	'groupingSets',
	'hop',
	'hopEnd',
	'hopStart',
	'index',
	'indexView',
	'int',
	'int16',
	'int8',
	'integer',
	'intersect',
	'interval',
	'interval64',
	'intoResult',
	'json',
	'jsonDocument',
	'kMeansTreeSearchTopSize',
	'knnCosineDistance',
	'knnCosineSimilarity',
	'knnDistance',
	'knnEuclideanDistance',
	'knnInnerProductSimilarity',
	'knnManhattanDistance',
	'knnSimilarity',
	'many',
	'matchRecognize',
	'migrate',
	'one',
	'partitionByHash',
	'pragma',
	'primaryKey',
	'rawTableOption',
	'relations',
	'rollup',
	'sessionStart',
	'sessionWindow',
	'tableOptions',
	'text',
	'timestamp',
	'timestamp64',
	'ttl',
	'uint16',
	'uint32',
	'uint64',
	'uint8',
	'union',
	'unionAll',
	'unique',
	'uniqueHint',
	'uniqueIndex',
	'uuid',
	'values',
	'valuesTable',
	'vectorIndex',
	'vectorIndexView',
	'windowDefinition',
	'ydbTable',
	'ydbTableCreator',
	'yqlScript',
	'yson',
] as const

test('root public API exposes exactly the stable runtime surface', () => {
	assert.deepEqual(Object.keys(publicApi).sort(), [...expectedRootRuntimeExports])
})

test('root public API re-exports runtime entry points', () => {
	assert.equal(publicApi.YdbDriver, YdbDriver)
	assert.equal(publicApi.YdbAuthenticationError, YdbAuthenticationError)
	assert.equal(publicApi.YdbCancelledQueryError, YdbCancelledQueryError)
	assert.equal(publicApi.YdbOverloadedQueryError, YdbOverloadedQueryError)
	assert.equal(publicApi.YdbQueryExecutionError, YdbQueryExecutionError)
	assert.equal(publicApi.YdbRetryableQueryError, YdbRetryableQueryError)
	assert.equal(publicApi.YdbTimeoutQueryError, YdbTimeoutQueryError)
	assert.equal(publicApi.YdbUnavailableQueryError, YdbUnavailableQueryError)
	assert.equal(publicApi.YdbUniqueConstraintViolationError, YdbUniqueConstraintViolationError)
	assert.equal(publicApi.drizzle, drizzle)
	assert.equal(publicApi.createDrizzle, createDrizzle)
	assert.equal(publicApi.relations, relations)
	assert.equal(publicApi.one, createOne)
	assert.equal(publicApi.many, createMany)
	assert.equal(publicApi.ydbTable, ydbTable)
	assert.equal(publicApi.integer, integer)
	assert.equal(publicApi.int, integer)
	assert.equal(publicApi.text, text)
	assert.equal(publicApi.customType, customType)
	assert.equal(publicApi.index, index)
	assert.equal(publicApi.indexView, indexView)
	assert.equal(publicApi.uniqueIndex, uniqueIndex)
	assert.equal(publicApi.vectorIndex, vectorIndex)
	assert.equal(publicApi.vectorIndexView, vectorIndexView)
	assert.equal(publicApi.boolean, boolean)
	assert.equal(publicApi.bigint, bigint)
	assert.equal(publicApi.int8, int8)
	assert.equal(publicApi.int16, int16)
	assert.equal(publicApi.uint8, uint8)
	assert.equal(publicApi.uint16, uint16)
	assert.equal(publicApi.uint32, uint32)
	assert.equal(publicApi.uint64, uint64)
	assert.equal(publicApi.float, float)
	assert.equal(publicApi.double, double)
	assert.equal(publicApi.dyNumber, dyNumber)
	assert.equal(publicApi.bytes, bytes)
	assert.equal(publicApi.binary, binary)
	assert.equal(publicApi.date, date)
	assert.equal(publicApi.date32, date32)
	assert.equal(publicApi.datetime, datetime)
	assert.equal(publicApi.datetime64, datetime64)
	assert.equal(publicApi.timestamp, timestamp)
	assert.equal(publicApi.timestamp64, timestamp64)
	assert.equal(publicApi.interval, interval)
	assert.equal(publicApi.interval64, interval64)
	assert.equal(publicApi.json, json)
	assert.equal(publicApi.jsonDocument, jsonDocument)
	assert.equal(publicApi.uuid, uuid)
	assert.equal(publicApi.yson, yson)
	assert.equal(publicApi.decimal, decimal)
	assert.equal(publicApi.primaryKey, primaryKey)
	assert.equal(publicApi.unique, unique)
	assert.equal(publicApi.buildCreateTableSql, buildCreateTableSql)
	assert.equal(publicApi.buildAddColumnFamilySql, buildAddColumnFamilySql)
	assert.equal(publicApi.buildAddChangefeedSql, buildAddChangefeedSql)
	assert.equal(publicApi.buildAlterAsyncReplicationSql, buildAlterAsyncReplicationSql)
	assert.equal(publicApi.buildAlterGroupSql, buildAlterGroupSql)
	assert.equal(publicApi.buildAlterTableSql, buildAlterTableSql)
	assert.equal(publicApi.buildAlterColumnFamilySql, buildAlterColumnFamilySql)
	assert.equal(publicApi.buildAlterColumnSetFamilySql, buildAlterColumnSetFamilySql)
	assert.equal(publicApi.buildAlterTableResetOptionsSql, buildAlterTableResetOptionsSql)
	assert.equal(publicApi.buildAlterTableSetOptionsSql, buildAlterTableSetOptionsSql)
	assert.equal(publicApi.buildAlterTopicSql, buildAlterTopicSql)
	assert.equal(publicApi.buildAlterTransferSql, buildAlterTransferSql)
	assert.equal(publicApi.buildAlterUserSql, buildAlterUserSql)
	assert.equal(publicApi.buildAnalyzeSql, buildAnalyzeSql)
	assert.equal(publicApi.buildCreateAsyncReplicationSql, buildCreateAsyncReplicationSql)
	assert.equal(publicApi.buildCreateGroupSql, buildCreateGroupSql)
	assert.equal(publicApi.buildCreateSecretSql, buildCreateSecretSql)
	assert.equal(publicApi.buildCreateTopicSql, buildCreateTopicSql)
	assert.equal(publicApi.buildCreateTransferSql, buildCreateTransferSql)
	assert.equal(publicApi.buildCreateUserSql, buildCreateUserSql)
	assert.equal(publicApi.buildCreateViewSql, buildCreateViewSql)
	assert.equal(publicApi.buildDropAsyncReplicationSql, buildDropAsyncReplicationSql)
	assert.equal(publicApi.buildDropChangefeedSql, buildDropChangefeedSql)
	assert.equal(publicApi.buildDropGroupSql, buildDropGroupSql)
	assert.equal(publicApi.buildDropTopicSql, buildDropTopicSql)
	assert.equal(publicApi.buildDropTransferSql, buildDropTransferSql)
	assert.equal(publicApi.buildDropUserSql, buildDropUserSql)
	assert.equal(publicApi.buildDropViewSql, buildDropViewSql)
	assert.equal(publicApi.buildGrantSql, buildGrantSql)
	assert.equal(publicApi.buildMigrationLockTableBootstrapSql, buildMigrationLockTableBootstrapSql)
	assert.equal(publicApi.buildRenameTableSql, buildRenameTableSql)
	assert.equal(publicApi.buildRevokeSql, buildRevokeSql)
	assert.equal(publicApi.buildShowCreateSql, buildShowCreateSql)
	assert.equal(publicApi.migrate, migrate)
	assert.equal(publicApi.tableOptions, tableOptions)
	assert.equal(publicApi.rawTableOption, rawTableOption)
	assert.equal(publicApi.partitionByHash, partitionByHash)
	assert.equal(publicApi.ttl, ttl)
	assert.equal(publicApi.columnFamily, columnFamily)
	assert.equal(publicApi.union, union)
	assert.equal(publicApi.unionAll, unionAll)
	assert.equal(publicApi.intersect, intersect)
	assert.equal(publicApi.except, except)
	assert.equal(publicApi.asTable, asTable)
	assert.equal(publicApi.commit, commit)
	assert.equal(publicApi.cube, cube)
	assert.equal(publicApi.declareParam, declareParam)
	assert.equal(publicApi.defineAction, defineAction)
	assert.equal(publicApi.distinctHint, distinctHint)
	assert.equal(publicApi.doAction, doAction)
	assert.equal(publicApi.doBlock, doBlock)
	assert.equal(publicApi.groupKey, groupKey)
	assert.equal(publicApi.grouping, grouping)
	assert.equal(publicApi.groupingSets, groupingSets)
	assert.equal(publicApi.hop, hop)
	assert.equal(publicApi.hopEnd, hopEnd)
	assert.equal(publicApi.hopStart, hopStart)
	assert.equal(publicApi.intoResult, intoResult)
	assert.equal(publicApi.kMeansTreeSearchTopSize, kMeansTreeSearchTopSize)
	assert.equal(publicApi.knnCosineDistance, knnCosineDistance)
	assert.equal(publicApi.knnCosineSimilarity, knnCosineSimilarity)
	assert.equal(publicApi.knnDistance, knnDistance)
	assert.equal(publicApi.knnEuclideanDistance, knnEuclideanDistance)
	assert.equal(publicApi.knnInnerProductSimilarity, knnInnerProductSimilarity)
	assert.equal(publicApi.knnManhattanDistance, knnManhattanDistance)
	assert.equal(publicApi.knnSimilarity, knnSimilarity)
	assert.equal(publicApi.values, values)
	assert.equal(publicApi.valuesTable, valuesTable)
	assert.equal(publicApi.matchRecognize, matchRecognize)
	assert.equal(publicApi.pragma, pragma)
	assert.equal(publicApi.rollup, rollup)
	assert.equal(publicApi.sessionStart, sessionStart)
	assert.equal(publicApi.sessionWindow, sessionWindow)
	assert.equal(publicApi.uniqueHint, uniqueHint)
	assert.equal(publicApi.windowDefinition, windowDefinition)
	assert.equal(publicApi.yqlScript, yqlScript)
})

test('root public API does not expose implementation internals', () => {
	let internalRuntimeNames = [
		'YdbDialect',
		'YdbSession',
		'YdbTransaction',
		'YdbDatabase',
		'YdbCountBuilder',
		'YdbQueryBuilder',
		'YdbColumn',
		'YdbColumnBuilder',
	] as const

	for (let name of internalRuntimeNames) {
		assert.equal(Object.hasOwn(publicApi, name), false)
	}
})

test('internal migration SQL builders are not root public API', () => {
	let internalMigrationSqlBuilders = [
		'buildMigrationTableBootstrapSql',
		'buildMigrationHistoryMetadataProbeSql',
		'buildMigrationHistoryMetadataColumnSql',
		'buildMigrationHistorySelectSql',
		'buildMigrationHistoryInsertSql',
		'buildMigrationLockSelectSql',
		'buildMigrationLockUpsertSql',
		'buildMigrationLockRefreshSql',
		'buildMigrationLockReleaseSql',
	] as const

	for (let builderName of internalMigrationSqlBuilders) {
		assert.equal(Object.hasOwn(publicApi, builderName), false)
	}
})

test('query builder barrel re-exports concrete builder implementations', () => {
	assert.equal(queryBuilders.YdbCountBuilder, YdbCountBuilder)
	assert.equal(queryBuilders.YdbSelectBuilder, YdbSelectBuilder)
	assert.equal(queryBuilders.YdbInsertBuilder, YdbInsertBuilder)
	assert.equal(queryBuilders.YdbUpsertBuilder, YdbUpsertBuilder)
	assert.equal(queryBuilders.YdbReplaceBuilder, YdbReplaceBuilder)
	assert.equal(queryBuilders.YdbUpdateBuilder, YdbUpdateBuilder)
	assert.equal(queryBuilders.YdbBatchUpdateBuilder, YdbBatchUpdateBuilder)
	assert.equal(queryBuilders.YdbDeleteBuilder, YdbDeleteBuilder)
	assert.equal(queryBuilders.YdbBatchDeleteBuilder, YdbBatchDeleteBuilder)
	assert.equal(queryBuilders.YdbQueryBuilder, YdbQueryBuilder)
	assert.equal(queryBuilders.YdbRelationalQueryBuilder, YdbRelationalQueryBuilder)
	assert.equal(queryBuilders.YdbRelationalQuery, YdbRelationalQuery)
	assert.equal(queryBuilders.union, union)
	assert.equal(queryBuilders.unionAll, unionAll)
	assert.equal(queryBuilders.intersect, intersect)
	assert.equal(queryBuilders.except, except)
	assert.equal(queryBuilders.asTable, asTable)
	assert.equal(queryBuilders.commit, commit)
	assert.equal(queryBuilders.cube, cube)
	assert.equal(queryBuilders.declareParam, declareParam)
	assert.equal(queryBuilders.defineAction, defineAction)
	assert.equal(queryBuilders.distinctHint, distinctHint)
	assert.equal(queryBuilders.doAction, doAction)
	assert.equal(queryBuilders.doBlock, doBlock)
	assert.equal(queryBuilders.groupKey, groupKey)
	assert.equal(queryBuilders.grouping, grouping)
	assert.equal(queryBuilders.groupingSets, groupingSets)
	assert.equal(queryBuilders.hop, hop)
	assert.equal(queryBuilders.hopEnd, hopEnd)
	assert.equal(queryBuilders.hopStart, hopStart)
	assert.equal(queryBuilders.intoResult, intoResult)
	assert.equal(queryBuilders.kMeansTreeSearchTopSize, kMeansTreeSearchTopSize)
	assert.equal(queryBuilders.knnCosineDistance, knnCosineDistance)
	assert.equal(queryBuilders.knnCosineSimilarity, knnCosineSimilarity)
	assert.equal(queryBuilders.knnDistance, knnDistance)
	assert.equal(queryBuilders.knnEuclideanDistance, knnEuclideanDistance)
	assert.equal(queryBuilders.knnInnerProductSimilarity, knnInnerProductSimilarity)
	assert.equal(queryBuilders.knnManhattanDistance, knnManhattanDistance)
	assert.equal(queryBuilders.knnSimilarity, knnSimilarity)
	assert.equal(queryBuilders.values, values)
	assert.equal(queryBuilders.valuesTable, valuesTable)
	assert.equal(queryBuilders.matchRecognize, matchRecognize)
	assert.equal(queryBuilders.pragma, pragma)
	assert.equal(queryBuilders.rollup, rollup)
	assert.equal(queryBuilders.sessionStart, sessionStart)
	assert.equal(queryBuilders.sessionWindow, sessionWindow)
	assert.equal(queryBuilders.uniqueHint, uniqueHint)
	assert.equal(queryBuilders.windowDefinition, windowDefinition)
	assert.equal(queryBuilders.yqlScript, yqlScript)
})
