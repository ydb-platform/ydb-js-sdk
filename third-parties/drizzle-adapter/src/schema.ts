// Schema declaration surface: tables, columns, constraints, indexes, options.
// Pair with `@ydbjs/drizzle-adapter` (driver/client) and
// `@ydbjs/drizzle-adapter/sql` (YQL expressions).

export { ydbTable, ydbTableCreator, type YdbTable, type YdbTableFn } from './ydb-core/table.js'
export { primaryKey } from './ydb-core/primary-keys.js'
export { unique } from './ydb-core/unique-constraint.js'
export {
	columnFamily,
	partitionByHash,
	rawTableOption,
	tableOptions,
	ttl,
	type YdbColumnFamilyOptions,
	type YdbTableOptionValue,
	type YdbTtlAction,
	type YdbTtlUnit,
} from './ydb-core/table-options.js'
export {
	index,
	indexView,
	uniqueIndex,
	vectorIndex,
	vectorIndexView,
	type YdbVectorDistance,
	type YdbVectorKMeansTreeOptions,
	type YdbVectorSimilarity,
	type YdbVectorType,
} from './ydb-core/indexes.js'
export { customType } from './ydb-core/columns/custom.js'
export { int, integer } from './ydb-core/columns/integer.js'
export { text } from './ydb-core/columns/text.js'
export {
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
	int8,
	int16,
	interval,
	interval64,
	json,
	jsonDocument,
	timestamp,
	timestamp64,
	uint8,
	uint16,
	uint32,
	uint64,
	uuid,
	yson,
} from './ydb-core/columns/types.js'
export type {
	YdbSchemaDefinition,
	YdbSchemaRelations,
	YdbSchemaWithoutTables,
} from './ydb-core/schema.types.js'
