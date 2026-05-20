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
	let seen = new Set<YdbColumn>()
	let result: YdbColumn[] = []

	for (let column of columns) {
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

let relationalRelationParameterBudget = 256

function chunkRelationTuples(tuples: unknown[][], columnCount: number): unknown[][][] {
	let chunkSize = Math.max(
		1,
		Math.floor(relationalRelationParameterBudget / Math.max(1, columnCount))
	)
	let chunks: unknown[][][] = []

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

	let explicitEntries = Object.entries(config.columns).filter(
		([key, include]) => key in tableConfig.columns && include !== undefined
	)
	let includeKeys = explicitEntries.filter(([, include]) => include === true).map(([key]) => key)

	if (includeKeys.length > 0) {
		return includeKeys
	}

	let excludeKeys = new Set(
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

	let aliasedColumns = getAliasedColumns(tableConfig, tableAlias)
	let whereSql =
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

	let aliasedColumns = getAliasedColumns(tableConfig, tableAlias)
	let orderBy =
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
	let offset = 'offset' in config ? config.offset : undefined
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

	let aliasedColumns = getAliasedColumns(tableConfig, tableAlias)
	let extras =
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
		let column = columns[0]!
		let values = tuples.map(([value]) => value)
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

	readonly #fullSchema: Record<string, unknown>
	readonly #schema: TSchema
	readonly #tableNamesMap: Record<string, string>
	readonly #table: YdbTable
	readonly #tableConfig: TFields
	readonly #dialect: YdbDialect
	readonly #session: YdbSession

	constructor(
		fullSchema: Record<string, unknown>,
		schema: TSchema,
		tableNamesMap: Record<string, string>,
		table: YdbTable,
		tableConfig: TFields,
		dialect: YdbDialect,
		session: YdbSession
	) {
		this.#fullSchema = fullSchema
		this.#schema = schema
		this.#tableNamesMap = tableNamesMap
		this.#table = table
		this.#tableConfig = tableConfig
		this.#dialect = dialect
		this.#session = session
	}

	findMany<TConfig extends YdbRelationalManyConfig<TSchema, TFields>>(
		config?: KnownKeysOnly<TConfig, YdbRelationalManyConfig<TSchema, TFields>>
	): YdbRelationalQuery<BuildQueryResult<TSchema, TFields, TConfig>[]> {
		return new YdbRelationalQuery(
			this.#fullSchema,
			this.#schema,
			this.#tableNamesMap,
			this.#table,
			this.#tableConfig,
			this.#dialect,
			this.#session,
			(config ?? {}) as YdbRelationalAnyConfig,
			'many'
		)
	}

	findFirst<TConfig extends YdbRelationalFirstConfig<TSchema, TFields>>(
		config?: KnownKeysOnly<TConfig, YdbRelationalFirstConfig<TSchema, TFields>>
	): YdbRelationalQuery<BuildQueryResult<TSchema, TFields, TConfig> | undefined> {
		return new YdbRelationalQuery(
			this.#fullSchema,
			this.#schema,
			this.#tableNamesMap,
			this.#table,
			this.#tableConfig,
			this.#dialect,
			this.#session,
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

	readonly #fullSchema: Record<string, unknown>
	readonly #schema: TablesRelationalConfig
	readonly #tableNamesMap: Record<string, string>
	readonly #table: YdbTable
	readonly #tableConfig: TableRelationalConfig
	readonly #dialect: YdbDialect
	readonly #session: YdbSession
	readonly #config: YdbRelationalAnyConfig
	readonly #mode: 'many' | 'first'

	constructor(
		fullSchema: Record<string, unknown>,
		schema: TablesRelationalConfig,
		tableNamesMap: Record<string, string>,
		table: YdbTable,
		tableConfig: TableRelationalConfig,
		dialect: YdbDialect,
		session: YdbSession,
		config: YdbRelationalAnyConfig,
		mode: 'many' | 'first'
	) {
		super()
		this.#fullSchema = fullSchema
		this.#schema = schema
		this.#tableNamesMap = tableNamesMap
		this.#table = table
		this.#tableConfig = tableConfig
		this.#dialect = dialect
		this.#session = session
		this.#config = config
		this.#mode = mode
	}

	#getSelectedRelations(
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

			let relation = tableConfig.relations[tsKey]
			if (!relation) {
				throw new Error(
					`YDB relational query relation "${tableConfig.tsName}.${tsKey}" is missing`
				)
			}

			let relationTableTsName =
				this.#tableNamesMap[getTableUniqueName(relation.referencedTable)]
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
						this.#schema,
						this.#tableNamesMap,
						relation
					),
				},
			]
		})
	}

	#buildFlatQueryPlan({
		table,
		tableConfig,
		config,
		tableAlias,
		requiredColumns = [],
		extraWhere,
		applyLimit = true,
		applyOffset = true,
	}: YdbExecuteLevelOptions): YdbFlatQueryPlan {
		let selectedRelations = this.#getSelectedRelations(tableConfig, config)
		let selectedColumnKeys = getSelectedColumnKeys(tableConfig, config)
		let selectedExtras = getExtrasSelection(tableConfig, config, tableAlias)

		let columnEntries = selectedColumnKeys.map((tsKey, index) => ({
			tsKey,
			alias: `__ydb_c${index}`,
			field: aliasedTableColumn(tableConfig.columns[tsKey]!, tableAlias),
		}))
		let extraEntries = selectedExtras.map(({ tsKey, field }, index) => ({
			tsKey,
			alias: `__ydb_e${index}`,
			field,
		}))

		let hiddenColumnAliases = new Map<YdbColumn, string>()
		for (let entry of columnEntries) {
			hiddenColumnAliases.set(tableConfig.columns[entry.tsKey] as YdbColumn, entry.alias)
		}

		let hiddenFields: Array<{ alias: string; field: SQLWrapper }> = []
		let hiddenColumns = dedupeColumns([
			...requiredColumns,
			...selectedRelations.flatMap(
				({ normalizedRelation }) => normalizedRelation.fields as YdbColumn[]
			),
		])

		let hiddenIndex = 0
		for (let column of hiddenColumns) {
			if (hiddenColumnAliases.has(column)) {
				continue
			}

			let alias = `__ydb_h${hiddenIndex++}`
			hiddenColumnAliases.set(column, alias)
			hiddenFields.push({
				alias,
				field: aliasedTableColumn(column, tableAlias),
			})
		}

		let fields = [...columnEntries, ...extraEntries, ...hiddenFields]
		if (fields.length === 0) {
			throw new Error(`YDB relational query selected zero fields for "${tableConfig.tsName}"`)
		}

		let where = and(
			extraWhere ? mapColumnsInSQLToAlias(extraWhere, tableAlias) : undefined,
			getWhereClause(tableConfig, config, tableAlias)
		)
		let orderBy = getOrderByClause(tableConfig, config, tableAlias)
		let limit = applyLimit ? getLimitClause(config) : undefined
		let offset = applyOffset ? getOffsetClause(config) : undefined

		return {
			sql: this.#dialect.buildSelectQuery({
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

	#getColumnTuple(
		row: Record<string, unknown>,
		columns: YdbColumn[],
		aliases: Map<YdbColumn, string>
	): unknown[] {
		return columns.map((column) => {
			let alias = aliases.get(column)
			if (!alias) {
				throw new Error(
					`YDB relational query hidden alias for column "${column.name}" is missing`
				)
			}

			return row[alias]
		})
	}

	async #executeLevel(options: YdbExecuteLevelOptions): Promise<YdbExecutedLevel> {
		let plan = this.#buildFlatQueryPlan(options)
		let rows = await this.#session
			.prepareQuery<YdbPreparedQueryConfig & { execute: Array<Record<string, unknown>> }>(
				plan.sql,
				undefined,
				undefined,
				false
			)
			.execute()
		let values = rows.map((row) => {
			let result: Record<string, unknown> = {}

			for (let entry of plan.columnEntries) {
				result[entry.tsKey] = row[entry.alias]
			}

			for (let entry of plan.extraEntries) {
				result[entry.tsKey] = row[entry.alias]
			}

			return result
		})

		for (let relation of plan.selectedRelations) {
			await this.#hydrateRelation(plan, rows, values, relation)
		}

		return { plan, rows, values }
	}

	async #hydrateRelation(
		parentPlan: YdbFlatQueryPlan,
		parentRows: Array<Record<string, unknown>>,
		parentValues: Array<Record<string, unknown>>,
		relationSelection: YdbSelectedRelation
	): Promise<void> {
		let parentTuples = parentRows
			.map((row) =>
				this.#getColumnTuple(
					row,
					relationSelection.normalizedRelation.fields as YdbColumn[],
					parentPlan.hiddenColumnAliases
				)
			)
			.filter((tuple) => tuple.every((value) => value !== null && value !== undefined))

		if (parentTuples.length === 0) {
			for (let parentValue of parentValues) {
				parentValue[relationSelection.tsKey] = is(relationSelection.relation, One)
					? null
					: []
			}
			return
		}

		let uniqueParentTuples = Array.from(
			new Map(parentTuples.map((tuple) => [getTupleKey(tuple), tuple])),
			([, tuple]) => tuple
		)
		let relationTableConfig = this.#schema[relationSelection.relationTableTsName]
		let relationTable = this.#fullSchema[relationSelection.relationTableTsName] as
			| YdbTable
			| undefined

		if (!relationTableConfig || !relationTable) {
			throw new Error(
				`YDB relational query table "${relationSelection.relationTableTsName}" is missing`
			)
		}

		let relationConfig =
			relationSelection.queryConfig === true
				? ({} as YdbRelationalAnyConfig)
				: (relationSelection.queryConfig as YdbRelationalAnyConfig)
		let referenceColumns = relationSelection.normalizedRelation.references as YdbColumn[]
		let relationResults: YdbExecutedLevel[] = []

		for (let tupleChunk of chunkRelationTuples(uniqueParentTuples, referenceColumns.length)) {
			let relationFilter = buildRelationFilter(referenceColumns, tupleChunk)
			let relationResult = await this.#executeLevel({
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

		let groupedValues = new Map<string, Array<Record<string, unknown>>>()
		for (let relationResult of relationResults) {
			for (let [index, row] of relationResult.rows.entries()) {
				let key = getTupleKey(
					this.#getColumnTuple(
						row,
						referenceColumns,
						relationResult.plan.hiddenColumnAliases
					)
				)
				let existing = groupedValues.get(key)

				if (existing) {
					existing.push(relationResult.values[index]!)
				} else {
					groupedValues.set(key, [relationResult.values[index]!])
				}
			}
		}

		let relationOffset = getOffsetClause(relationConfig) ?? 0
		let relationLimit = getLimitClause(relationConfig)

		for (let [index, parentValue] of parentValues.entries()) {
			let tuple = this.#getColumnTuple(
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

			let relatedValues = groupedValues.get(getTupleKey(tuple)) ?? []
			if (is(relationSelection.relation, One)) {
				parentValue[relationSelection.tsKey] = relatedValues[0] ?? null
				continue
			}

			let sliced =
				relationLimit === undefined
					? relatedValues.slice(relationOffset)
					: relatedValues.slice(relationOffset, relationOffset + relationLimit)
			parentValue[relationSelection.tsKey] = sliced
		}
	}

	getSQL(): SQL {
		return this.#buildFlatQueryPlan({
			table: this.#table,
			tableConfig: this.#tableConfig,
			config: this.#config,
			tableAlias: this.#tableConfig.tsName,
		}).sql
	}

	async #run(): Promise<TResult> {
		let result = await this.#executeLevel({
			table: this.#table,
			tableConfig: this.#tableConfig,
			config: this.#config,
			tableAlias: this.#tableConfig.tsName,
		})

		if (this.#mode === 'first') {
			return result.values[0] as TResult | undefined as TResult
		}

		return result.values as TResult
	}

	prepare(name?: string) {
		let flatPrepared = this.#session.prepareQuery(this.getSQL(), undefined, name, false)

		return {
			getQuery: () => {
				return flatPrepared.getQuery()
			},
			execute: async () => {
				return this.#run()
			},
			all: async () => {
				let result = await this.#run()
				if (Array.isArray(result)) {
					return result
				}

				return result === undefined ? [] : [result]
			},
			get: async () => {
				let result = await this.#run()
				return Array.isArray(result) ? result[0] : result
			},
			values: async () => {
				return flatPrepared.values()
			},
		}
	}

	toSQL() {
		let prepared = this.prepare()
		let { typings: _typings, ...query } = prepared.getQuery()
		return query
	}

	override execute(): Promise<TResult> {
		return this.#run()
	}
}
