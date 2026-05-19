// eslint-disable no-await-in-loop
import {
	aliasedTable,
	aliasedTableColumn,
	mapColumnsInAliasedSQLToAlias,
	mapColumnsInSQLToAlias,
} from 'drizzle-orm/alias'
import { Column } from 'drizzle-orm/column'
import { entityKind, is } from 'drizzle-orm/entity'
import {
	type BuildQueryResult,
	type DBQueryConfig,
	Many,
	One,
	type Relation,
	type TableRelationalConfig,
	type TablesRelationalConfig,
	getOperators,
	getOrderByOperators,
	normalizeRelation,
} from 'drizzle-orm/relations'
import { QueryPromise } from 'drizzle-orm/query-promise'
import { and, eq, inArray, or } from 'drizzle-orm/sql/expressions'
import { type SQL, type SQLWrapper, sql as yql } from 'drizzle-orm/sql/sql'
import { getTableUniqueName } from 'drizzle-orm/table'
import type { KnownKeysOnly, ValueOrArray } from 'drizzle-orm/utils'
import type { YdbDialect } from '../../ydb/dialect.js'
import type { YdbPreparedQueryConfig, YdbSession } from '../session.js'
import type { YdbColumn } from '../columns/common.js'
import type { YdbTable } from '../table.js'

function toArray<T>(value: ValueOrArray<T> | undefined): T[] {
	if (value === undefined) {
		return []
	}

	return Array.isArray(value) ? value : [value]
}

function isNumberValue(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value)
}

function dedupeColumns(columns: YdbColumn[]): YdbColumn[] {
	const seen = new Set<YdbColumn>()
	const result: YdbColumn[] = []

	for (const column of columns) {
		if (seen.has(column)) {
			continue
		}

		seen.add(column)
		result.push(column)
	}

	return result
}

function encodeTuplePart(value: unknown): string {
	if (typeof value === 'bigint') {
		return `bigint:${value.toString()}`
	}

	if (value instanceof Date) {
		return `date:${value.toISOString()}`
	}

	if (value instanceof Uint8Array) {
		return `bytes:${Buffer.from(value).toString('base64')}`
	}

	if (value === null) {
		return 'null:'
	}

	if (value === undefined) {
		return 'undefined:'
	}

	return `${typeof value}:${String(value)}`
}

function getTupleKey(values: unknown[]): string {
	return values.map((value) => encodeTuplePart(value)).join('|')
}

type YdbRelationalManyConfig<
	TSchema extends TablesRelationalConfig,
	TFields extends TableRelationalConfig,
> = DBQueryConfig<'many', true, TSchema, TFields>

type YdbRelationalFirstConfig<
	TSchema extends TablesRelationalConfig,
	TFields extends TableRelationalConfig,
> = Omit<DBQueryConfig<'many', true, TSchema, TFields>, 'limit'>

type YdbRelationalAnyConfig = DBQueryConfig<'many', boolean>

type YdbVisibleSelectionEntry = {
	tsKey: string
	alias: string
	field: SQLWrapper
}

type YdbSelectedRelation = {
	tsKey: string
	relation: Relation
	relationTableTsName: string
	queryConfig: true | DBQueryConfig<'many', false>
	normalizedRelation: ReturnType<typeof normalizeRelation>
}

type YdbFlatQueryPlan = {
	sql: SQL
	tableAlias: string
	columnEntries: YdbVisibleSelectionEntry[]
	extraEntries: YdbVisibleSelectionEntry[]
	hiddenColumnAliases: Map<YdbColumn, string>
	selectedRelations: YdbSelectedRelation[]
}

type YdbExecutedLevel = {
	plan: YdbFlatQueryPlan
	rows: Array<Record<string, unknown>>
	values: Array<Record<string, unknown>>
}

type YdbExecuteLevelOptions = {
	table: YdbTable
	tableConfig: TableRelationalConfig
	config: YdbRelationalAnyConfig
	tableAlias: string
	requiredColumns?: YdbColumn[]
	extraWhere?: SQL
	applyLimit?: boolean
	applyOffset?: boolean
}

const relationalRelationParameterBudget = 256

function chunkRelationTuples(tuples: unknown[][], columnCount: number): unknown[][][] {
	const chunkSize = Math.max(
		1,
		Math.floor(relationalRelationParameterBudget / Math.max(1, columnCount))
	)
	const chunks: unknown[][][] = []

	for (let index = 0; index < tuples.length; index += chunkSize) {
		chunks.push(tuples.slice(index, index + chunkSize))
	}

	return chunks
}

function getSelectedColumnKeys(
	tableConfig: TableRelationalConfig,
	config: YdbRelationalAnyConfig
): string[] {
	if (!config.columns) {
		return Object.keys(tableConfig.columns)
	}

	const explicitEntries = Object.entries(config.columns).filter(
		([key, include]) => key in tableConfig.columns && include !== undefined
	)
	const includeKeys = explicitEntries
		.filter(([, include]) => include === true)
		.map(([key]) => key)

	if (includeKeys.length > 0) {
		return includeKeys
	}

	const excludeKeys = new Set(
		explicitEntries.filter(([, include]) => include === false).map(([key]) => key)
	)

	return Object.keys(tableConfig.columns).filter((key) => !excludeKeys.has(key))
}

function getAliasedColumns(
	tableConfig: TableRelationalConfig,
	tableAlias: string
): Record<string, Column> {
	return Object.fromEntries(
		Object.entries(tableConfig.columns).map(([key, value]) => [
			key,
			aliasedTableColumn(value, tableAlias),
		])
	) as Record<string, Column>
}

function getWhereClause(
	tableConfig: TableRelationalConfig,
	config: YdbRelationalAnyConfig,
	tableAlias: string
): SQL | undefined {
	if (config.where === undefined) {
		return undefined
	}

	const aliasedColumns = getAliasedColumns(tableConfig, tableAlias)
	const whereSql =
		typeof config.where === 'function'
			? config.where(aliasedColumns as Record<string, YdbColumn>, getOperators())
			: config.where

	return whereSql ? mapColumnsInSQLToAlias(whereSql, tableAlias) : undefined
}

function getOrderByClause(
	tableConfig: TableRelationalConfig,
	config: YdbRelationalAnyConfig,
	tableAlias: string
): SQL[] {
	if (config.orderBy === undefined) {
		return []
	}

	const aliasedColumns = getAliasedColumns(tableConfig, tableAlias)
	const orderBy =
		typeof config.orderBy === 'function'
			? config.orderBy(aliasedColumns as Record<string, YdbColumn>, getOrderByOperators())
			: config.orderBy

	return toArray(orderBy).map((field) => {
		if (is(field, Column)) {
			return aliasedTableColumn(field, tableAlias) as unknown as SQL
		}

		return mapColumnsInSQLToAlias(field as SQL, tableAlias)
	})
}

function getLimitClause(config: YdbRelationalAnyConfig): number | undefined {
	if (config.limit === undefined) {
		return undefined
	}

	if (!isNumberValue(config.limit)) {
		throw new Error('YDB relational query limit must be a finite number')
	}

	return config.limit
}

function getOffsetClause(config: YdbRelationalAnyConfig): number | undefined {
	const offset = 'offset' in config ? config.offset : undefined
	if (offset === undefined) {
		return undefined
	}

	if (!isNumberValue(offset)) {
		throw new Error('YDB relational query offset must be a finite number')
	}

	return offset
}

function getExtrasSelection(
	tableConfig: TableRelationalConfig,
	config: YdbRelationalAnyConfig,
	tableAlias: string
): Array<{ tsKey: string; field: SQL.Aliased }> {
	if (!config.extras) {
		return []
	}

	const aliasedColumns = getAliasedColumns(tableConfig, tableAlias)
	const extras =
		typeof config.extras === 'function'
			? config.extras(aliasedColumns as Record<string, YdbColumn>, { sql: yql })
			: config.extras

	return Object.entries(extras).map(([tsKey, value]) => ({
		tsKey,
		field: mapColumnsInAliasedSQLToAlias(value, tableAlias) as SQL.Aliased,
	}))
}

function buildRelationFilter(columns: YdbColumn[], tuples: unknown[][]): SQL {
	if (columns.length === 0) {
		throw new Error('YDB relational relation filter requires at least one column')
	}

	if (columns.length === 1) {
		const column = columns[0]!
		const values = tuples.map(([value]) => value)
		return values.length === 1 ? eq(column, values[0]) : inArray(column, values)
	}

	if (tuples.length === 1) {
		return and(...columns.map((column, index) => eq(column, tuples[0]![index])))!
	}

	return or(
		...tuples.map((tuple) => and(...columns.map((column, index) => eq(column, tuple[index]))))
	)!
}

export class YdbRelationalQueryBuilder<
	TSchema extends TablesRelationalConfig,
	TFields extends TableRelationalConfig,
> {
	static readonly [entityKind] = 'YdbRelationalQueryBuilder'

	constructor(
		private readonly fullSchema: Record<string, unknown>,
		private readonly schema: TSchema,
		private readonly tableNamesMap: Record<string, string>,
		private readonly table: YdbTable,
		private readonly tableConfig: TFields,
		private readonly dialect: YdbDialect,
		private readonly session: YdbSession
	) {}

	findMany<TConfig extends YdbRelationalManyConfig<TSchema, TFields>>(
		config?: KnownKeysOnly<TConfig, YdbRelationalManyConfig<TSchema, TFields>>
	): YdbRelationalQuery<BuildQueryResult<TSchema, TFields, TConfig>[]> {
		return new YdbRelationalQuery(
			this.fullSchema,
			this.schema,
			this.tableNamesMap,
			this.table,
			this.tableConfig,
			this.dialect,
			this.session,
			(config ?? {}) as YdbRelationalAnyConfig,
			'many'
		)
	}

	findFirst<TConfig extends YdbRelationalFirstConfig<TSchema, TFields>>(
		config?: KnownKeysOnly<TConfig, YdbRelationalFirstConfig<TSchema, TFields>>
	): YdbRelationalQuery<BuildQueryResult<TSchema, TFields, TConfig> | undefined> {
		return new YdbRelationalQuery(
			this.fullSchema,
			this.schema,
			this.tableNamesMap,
			this.table,
			this.tableConfig,
			this.dialect,
			this.session,
			{ ...((config ?? {}) as YdbRelationalAnyConfig), limit: 1 },
			'first'
		)
	}
}

export class YdbRelationalQuery<TResult> extends QueryPromise<TResult> {
	static override readonly [entityKind] = 'YdbRelationalQuery'

	declare readonly _: {
		readonly dialect: 'ydb'
		readonly result: TResult
	}

	constructor(
		private readonly fullSchema: Record<string, unknown>,
		private readonly schema: TablesRelationalConfig,
		private readonly tableNamesMap: Record<string, string>,
		private readonly table: YdbTable,
		private readonly tableConfig: TableRelationalConfig,
		private readonly dialect: YdbDialect,
		private readonly session: YdbSession,
		private readonly config: YdbRelationalAnyConfig,
		private readonly mode: 'many' | 'first'
	) {
		super()
	}

	private getSelectedRelations(
		tableConfig: TableRelationalConfig,
		config: YdbRelationalAnyConfig
	): YdbSelectedRelation[] {
		if (!config.with) {
			return []
		}

		return Object.entries(config.with).flatMap(([tsKey, queryConfig]) => {
			if (!queryConfig) {
				return []
			}

			const relation = tableConfig.relations[tsKey]
			if (!relation) {
				throw new Error(
					`YDB relational query relation "${tableConfig.tsName}.${tsKey}" is missing`
				)
			}

			const relationTableTsName =
				this.tableNamesMap[getTableUniqueName(relation.referencedTable)]
			if (!relationTableTsName) {
				throw new Error(
					`YDB relational query table metadata for "${relation.referencedTableName}" is missing`
				)
			}

			return [
				{
					tsKey,
					relation,
					relationTableTsName,
					queryConfig: queryConfig as true | DBQueryConfig<'many', false>,
					normalizedRelation: normalizeRelation(
						this.schema,
						this.tableNamesMap,
						relation
					),
				},
			]
		})
	}

	private buildFlatQueryPlan({
		table,
		tableConfig,
		config,
		tableAlias,
		requiredColumns = [],
		extraWhere,
		applyLimit = true,
		applyOffset = true,
	}: YdbExecuteLevelOptions): YdbFlatQueryPlan {
		const selectedRelations = this.getSelectedRelations(tableConfig, config)
		const selectedColumnKeys = getSelectedColumnKeys(tableConfig, config)
		const selectedExtras = getExtrasSelection(tableConfig, config, tableAlias)

		const columnEntries = selectedColumnKeys.map((tsKey, index) => ({
			tsKey,
			alias: `__ydb_c${index}`,
			field: aliasedTableColumn(tableConfig.columns[tsKey]!, tableAlias),
		}))
		const extraEntries = selectedExtras.map(({ tsKey, field }, index) => ({
			tsKey,
			alias: `__ydb_e${index}`,
			field,
		}))

		const hiddenColumnAliases = new Map<YdbColumn, string>()
		for (const entry of columnEntries) {
			hiddenColumnAliases.set(tableConfig.columns[entry.tsKey] as YdbColumn, entry.alias)
		}

		const hiddenFields: Array<{ alias: string; field: SQLWrapper }> = []
		const hiddenColumns = dedupeColumns([
			...requiredColumns,
			...selectedRelations.flatMap(
				({ normalizedRelation }) => normalizedRelation.fields as YdbColumn[]
			),
		])

		let hiddenIndex = 0
		for (const column of hiddenColumns) {
			if (hiddenColumnAliases.has(column)) {
				continue
			}

			const alias = `__ydb_h${hiddenIndex++}`
			hiddenColumnAliases.set(column, alias)
			hiddenFields.push({
				alias,
				field: aliasedTableColumn(column, tableAlias),
			})
		}

		const fields = [...columnEntries, ...extraEntries, ...hiddenFields]
		if (fields.length === 0) {
			throw new Error(`YDB relational query selected zero fields for "${tableConfig.tsName}"`)
		}

		const where = and(
			extraWhere ? mapColumnsInSQLToAlias(extraWhere, tableAlias) : undefined,
			getWhereClause(tableConfig, config, tableAlias)
		)
		const orderBy = getOrderByClause(tableConfig, config, tableAlias)
		const limit = applyLimit ? getLimitClause(config) : undefined
		const offset = applyOffset ? getOffsetClause(config) : undefined

		return {
			sql: this.dialect.buildSelectQuery({
				table: aliasedTable(table, tableAlias),
				fields: {},
				fieldsFlat: fields.map(({ field }) => ({ path: [], field })),
				where,
				joins: undefined,
				orderBy,
				groupBy: undefined,
				having: undefined,
				limit,
				offset,
				distinct: false,
				distinctOn: undefined,
				selectionAliases: fields.map(({ alias }) => alias),
				setOperators: [],
			}),
			tableAlias,
			columnEntries,
			extraEntries,
			hiddenColumnAliases,
			selectedRelations,
		}
	}

	private getColumnTuple(
		row: Record<string, unknown>,
		columns: YdbColumn[],
		aliases: Map<YdbColumn, string>
	): unknown[] {
		return columns.map((column) => {
			const alias = aliases.get(column)
			if (!alias) {
				throw new Error(
					`YDB relational query hidden alias for column "${column.name}" is missing`
				)
			}

			return row[alias]
		})
	}

	private async executeLevel(options: YdbExecuteLevelOptions): Promise<YdbExecutedLevel> {
		const plan = this.buildFlatQueryPlan(options)
		const rows = await this.session
			.prepareQuery<YdbPreparedQueryConfig & { execute: Array<Record<string, unknown>> }>(
				plan.sql,
				undefined,
				undefined,
				false
			)
			.execute()
		const values = rows.map((row) => {
			const result: Record<string, unknown> = {}

			for (const entry of plan.columnEntries) {
				result[entry.tsKey] = row[entry.alias]
			}

			for (const entry of plan.extraEntries) {
				result[entry.tsKey] = row[entry.alias]
			}

			return result
		})

		for (const relation of plan.selectedRelations) {
			await this.hydrateRelation(plan, rows, values, relation)
		}

		return { plan, rows, values }
	}

	private async hydrateRelation(
		parentPlan: YdbFlatQueryPlan,
		parentRows: Array<Record<string, unknown>>,
		parentValues: Array<Record<string, unknown>>,
		relationSelection: YdbSelectedRelation
	): Promise<void> {
		const parentTuples = parentRows
			.map((row) =>
				this.getColumnTuple(
					row,
					relationSelection.normalizedRelation.fields as YdbColumn[],
					parentPlan.hiddenColumnAliases
				)
			)
			.filter((tuple) => tuple.every((value) => value !== null && value !== undefined))

		if (parentTuples.length === 0) {
			for (const parentValue of parentValues) {
				parentValue[relationSelection.tsKey] = is(relationSelection.relation, One)
					? null
					: []
			}
			return
		}

		const uniqueParentTuples = Array.from(
			new Map(parentTuples.map((tuple) => [getTupleKey(tuple), tuple])),
			([, tuple]) => tuple
		)
		const relationTableConfig = this.schema[relationSelection.relationTableTsName]
		const relationTable = this.fullSchema[relationSelection.relationTableTsName] as
			| YdbTable
			| undefined

		if (!relationTableConfig || !relationTable) {
			throw new Error(
				`YDB relational query table "${relationSelection.relationTableTsName}" is missing`
			)
		}

		const relationConfig =
			relationSelection.queryConfig === true
				? ({} as YdbRelationalAnyConfig)
				: (relationSelection.queryConfig as YdbRelationalAnyConfig)
		const referenceColumns = relationSelection.normalizedRelation.references as YdbColumn[]
		const relationResults: YdbExecutedLevel[] = []

		for (const tupleChunk of chunkRelationTuples(uniqueParentTuples, referenceColumns.length)) {
			const relationFilter = buildRelationFilter(referenceColumns, tupleChunk)
			const relationResult = await this.executeLevel({
				table: relationTable,
				tableConfig: relationTableConfig,
				config: relationConfig,
				tableAlias: `${parentPlan.tableAlias}_${relationSelection.tsKey}`,
				requiredColumns: referenceColumns,
				extraWhere: relationFilter,
				applyLimit: !is(relationSelection.relation, Many),
				applyOffset: !is(relationSelection.relation, Many),
			})
			relationResults.push(relationResult)
		}

		const groupedValues = new Map<string, Array<Record<string, unknown>>>()
		for (const relationResult of relationResults) {
			for (const [index, row] of relationResult.rows.entries()) {
				const key = getTupleKey(
					this.getColumnTuple(
						row,
						referenceColumns,
						relationResult.plan.hiddenColumnAliases
					)
				)
				const existing = groupedValues.get(key)

				if (existing) {
					existing.push(relationResult.values[index]!)
				} else {
					groupedValues.set(key, [relationResult.values[index]!])
				}
			}
		}

		const relationOffset = getOffsetClause(relationConfig) ?? 0
		const relationLimit = getLimitClause(relationConfig)

		for (const [index, parentValue] of parentValues.entries()) {
			const tuple = this.getColumnTuple(
				parentRows[index]!,
				relationSelection.normalizedRelation.fields as YdbColumn[],
				parentPlan.hiddenColumnAliases
			)

			if (tuple.some((value) => value === null || value === undefined)) {
				parentValue[relationSelection.tsKey] = is(relationSelection.relation, One)
					? null
					: []
				continue
			}

			const relatedValues = groupedValues.get(getTupleKey(tuple)) ?? []
			if (is(relationSelection.relation, One)) {
				parentValue[relationSelection.tsKey] = relatedValues[0] ?? null
				continue
			}

			const sliced =
				relationLimit === undefined
					? relatedValues.slice(relationOffset)
					: relatedValues.slice(relationOffset, relationOffset + relationLimit)
			parentValue[relationSelection.tsKey] = sliced
		}
	}

	getSQL(): SQL {
		return this.buildFlatQueryPlan({
			table: this.table,
			tableConfig: this.tableConfig,
			config: this.config,
			tableAlias: this.tableConfig.tsName,
		}).sql
	}

	private async run(): Promise<TResult> {
		const result = await this.executeLevel({
			table: this.table,
			tableConfig: this.tableConfig,
			config: this.config,
			tableAlias: this.tableConfig.tsName,
		})

		if (this.mode === 'first') {
			return result.values[0] as TResult | undefined as TResult
		}

		return result.values as TResult
	}

	prepare(name?: string) {
		const flatPrepared = this.session.prepareQuery(this.getSQL(), undefined, name, false)

		return {
			getQuery: () => {
				return flatPrepared.getQuery()
			},
			execute: async () => {
				return this.run()
			},
			all: async () => {
				const result = await this.run()
				if (Array.isArray(result)) {
					return result
				}

				return result === undefined ? [] : [result]
			},
			get: async () => {
				const result = await this.run()
				return Array.isArray(result) ? result[0] : result
			},
			values: async () => {
				return flatPrepared.values()
			},
		}
	}

	toSQL() {
		const prepared = this.prepare()
		const { typings: _typings, ...query } = prepared.getQuery()
		return query
	}

	override execute(): Promise<TResult> {
		return this.run()
	}
}
