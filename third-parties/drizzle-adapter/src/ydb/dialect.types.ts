import type {
	BuildRelationalQueryResult,
	DBQueryConfig,
	Relation,
	TableRelationalConfig,
	TablesRelationalConfig,
} from 'drizzle-orm/relations'
import type { MigrationMeta } from 'drizzle-orm/migrator'
import type { SQL, SQLWrapper } from 'drizzle-orm/sql/sql'
import type { Subquery } from 'drizzle-orm/subquery'
import type { UpdateSet } from 'drizzle-orm/utils'
import type { YdbSelectedFieldsOrdered } from '../ydb-core/result-mapping.js'
import type { YdbColumn } from '../ydb-core/columns/common.js'
import type {
	YdbFlattenConfig,
	YdbMatchRecognizeConfig,
	YdbSampleConfig,
	YdbUniqueDistinctHint,
	YdbWindowClause,
} from '../ydb-core/query-builders/select-syntax.js'
import type { YdbTable } from '../ydb-core/table.js'
import type { YdbMigrationTableConfig } from './migration-ddl.js'

export type YdbJoinType =
	| 'inner'
	| 'left'
	| 'right'
	| 'full'
	| 'cross'
	| 'left semi'
	| 'right semi'
	| 'left only'
	| 'right only'
	| 'exclusion'

export interface YdbJoinConfig {
	table: unknown
	joinType: YdbJoinType
	alias?: string | undefined
	on?: SQL | undefined
}

export interface YdbSetOperatorSource {
	getSelectedFields(): Record<string, unknown>
	getSQL(selectionAliases?: string[]): SQL
}

export interface YdbSetOperatorConfig {
	type: 'union' | 'intersect' | 'except'
	isAll: boolean
	rightSelect: YdbSetOperatorSource
	orderBy?: SQLWrapper[] | undefined
	limit?: number | undefined
	offset?: number | undefined
}

export interface YdbSelectConfig {
	table?: unknown | undefined
	fields: Record<string, unknown>
	fieldsFlat?: YdbSelectedFieldsOrdered | undefined
	withList?: Subquery[] | undefined
	joins?: YdbJoinConfig[] | undefined
	where?: SQL | undefined
	groupBy?: SQLWrapper[] | undefined
	groupByCompact?: boolean | undefined
	having?: SQL | undefined
	windows?: YdbWindowClause[] | undefined
	orderBy?: SQLWrapper[] | undefined
	assumeOrderBy?: SQLWrapper[] | undefined
	limit?: number | undefined
	offset?: number | undefined
	intoResult?: string | undefined
	without?: SQLWrapper[] | undefined
	flatten?: YdbFlattenConfig | undefined
	sample?: YdbSampleConfig | undefined
	matchRecognize?: YdbMatchRecognizeConfig | SQLWrapper | undefined
	uniqueDistinctHints?: YdbUniqueDistinctHint[] | undefined
	distinct?: boolean | undefined
	distinctOn?: SQLWrapper[] | undefined
	selectionAliases?: string[] | undefined
	setOperators: YdbSetOperatorConfig[]
}

export interface YdbInsertConfig {
	table: YdbTable
	values: Record<string, unknown>[] | SQL | SQLWrapper
	select?: boolean | undefined
	withList?: Subquery[] | undefined
	command?: 'insert' | 'upsert' | 'replace' | undefined
	columnEntries?: Array<[string, YdbColumn]> | undefined
	returning?: YdbSelectedFieldsOrdered | undefined
}

export interface YdbUpdateConfig {
	table: YdbTable
	set?: UpdateSet | Record<string, unknown> | undefined
	where?: SQL | undefined
	withList?: Subquery[] | undefined
	on?: SQL | SQLWrapper | undefined
	returning?: YdbSelectedFieldsOrdered | undefined
	batch?: boolean | undefined
}

export interface YdbDeleteConfig {
	table: YdbTable | SQLWrapper
	where?: SQL | undefined
	using?: SQLWrapper[] | undefined
	withList?: Subquery[] | undefined
	on?: SQL | SQLWrapper | undefined
	returning?: YdbSelectedFieldsOrdered | undefined
	batch?: boolean | undefined
}

export type YdbFlatRelationalQueryConfig = DBQueryConfig<'many', boolean>

export interface YdbRelationalQueryConfig {
	fullSchema: Record<string, unknown>
	schema: TablesRelationalConfig
	tableNamesMap: Record<string, string>
	table: YdbTable
	tableConfig: TableRelationalConfig
	queryConfig: true | YdbFlatRelationalQueryConfig
	tableAlias: string
	joinOn?: SQL | undefined
	nestedQueryRelation?: Relation | undefined
}

export type YdbRelationalQueryResult = BuildRelationalQueryResult<YdbTable, YdbColumn>

export interface YdbDialectMigrationConfig extends YdbMigrationTableConfig {}

export type YdbDialectMigration = MigrationMeta & { name?: string }
