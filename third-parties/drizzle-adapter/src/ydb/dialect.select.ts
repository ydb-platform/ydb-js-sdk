import { Column } from 'drizzle-orm/column'
import { is } from 'drizzle-orm/entity'
import { SQL, type SQLChunk, type SQLWrapper, sql as yql } from 'drizzle-orm/sql/sql'
import { Subquery } from 'drizzle-orm/subquery'
import { Table } from 'drizzle-orm/table'
import { type YdbSelectedFieldsOrdered, orderSelectedFields } from '../ydb-core/result-mapping.js'
import type { YdbJoinConfig, YdbSelectConfig, YdbSetOperatorConfig } from './dialect.types.js'
import {
	type YdbFlattenConfig,
	type YdbSampleConfig,
	type YdbWindowClause,
	matchRecognize as buildMatchRecognizeClause,
	renderUniqueDistinctHints,
} from '../ydb-core/query-builders/select-syntax.js'

function qualifyIdentifier(tableAlias: string, columnName: string): SQL {
	return yql`${yql.identifier(tableAlias)}.${yql.identifier(columnName)}`
}

function yqlBindingName(alias: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(alias)) {
		throw new Error(`YDB CTE alias "${alias}" cannot be used as a YQL binding name`)
	}

	return `$${alias}`
}

function findSelectionAlias(
	value: unknown,
	fields: YdbSelectedFieldsOrdered,
	selectionAliases: string[]
): string | undefined {
	const foundIndex = fields.findIndex(({ path, field }) => {
		if (field === value) {
			return true
		}

		if (is(value, SQL.Aliased)) {
			if (is(field, SQL.Aliased) && field.fieldAlias === value.fieldAlias) {
				return true
			}

			return path[path.length - 1] === value.fieldAlias
		}

		return false
	})

	return foundIndex >= 0 ? selectionAliases[foundIndex] : undefined
}

function mapChunkToSelectionAlias(
	chunk: SQLChunk,
	fields: YdbSelectedFieldsOrdered,
	selectionAliases: string[],
	context: string
): SQLChunk {
	if (is(chunk, SQL)) {
		return new SQL(
			chunk.queryChunks.map((value) =>
				mapChunkToSelectionAlias(value, fields, selectionAliases, context)
			)
		)
	}

	if (is(chunk, Column) || is(chunk, SQL.Aliased)) {
		const alias = findSelectionAlias(chunk, fields, selectionAliases)

		if (!alias) {
			throw new Error(`YDB ${context} can only reference selected fields`)
		}

		return yql.identifier(alias)
	}

	return chunk
}

export function getSelectionAliases(fields: YdbSelectedFieldsOrdered): string[] {
	return fields.map((_, index) => `__ydb_f${index}`)
}

export function mapExpressionsToSelectionAliases(
	expressions: SQLWrapper[],
	fields: YdbSelectedFieldsOrdered,
	selectionAliases: string[],
	context: string
): SQLWrapper[] {
	return expressions.map((expression) => {
		if (is(expression, Column) || is(expression, SQL.Aliased)) {
			const alias = findSelectionAlias(expression, fields, selectionAliases)

			if (!alias) {
				throw new Error(`YDB ${context} can only reference selected fields`)
			}

			return yql.identifier(alias)
		}

		if (is(expression, SQL)) {
			return new SQL(
				expression.queryChunks.map((chunk) =>
					mapChunkToSelectionAlias(chunk, fields, selectionAliases, context)
				)
			)
		}

		return expression
	})
}

export function buildSelection(fields: YdbSelectedFieldsOrdered, aliases?: string[]): SQL {
	if (fields.length === 0) {
		return yql.raw('*')
	}

	const selection = fields.map(({ field }, index) => {
		const alias = aliases?.[index]

		if (is(field, SQL.Aliased) && (field as any).isSelectionField) {
			const base = yql.identifier(field.fieldAlias)
			return alias ? yql`${base} as ${yql.identifier(alias)}` : base
		}

		if (is(field, SQL.Aliased)) {
			return alias
				? yql`${field.sql} as ${yql.identifier(alias)}`
				: yql`${field.sql} as ${yql.identifier(field.fieldAlias)}`
		}

		if (is(field, Column) || is(field, SQL) || is(field, Subquery)) {
			return alias
				? yql`${field as SQLWrapper} as ${yql.identifier(alias)}`
				: yql`${field as SQLWrapper}`
		}

		return alias
			? yql`${field as SQLWrapper} as ${yql.identifier(alias)}`
			: yql`${field as SQLWrapper}`
	})

	return yql.join(selection, yql`, `)
}

function buildSelectionWithout(without: SQLWrapper[]): SQL {
	return yql`* WITHOUT ${yql.join(
		without.map((value) => yql`${value}`),
		yql`, `
	)}`
}

export function buildReturningSelection(fields: YdbSelectedFieldsOrdered): SQL {
	if (fields.length === 0) {
		return yql.raw('*')
	}

	const selection = fields.map(({ field }) => {
		if (is(field, SQL.Aliased) && (field as any).isSelectionField) {
			return yql.identifier(field.fieldAlias)
		}

		if (is(field, SQL.Aliased)) {
			return yql`${field.sql} as ${yql.identifier(field.fieldAlias)}`
		}

		if (is(field, Column)) {
			return yql.identifier(field.name)
		}

		return yql`${field as SQLWrapper}`
	})

	return yql.join(selection, yql`, `)
}

export function buildFromTable(table: unknown): SQLWrapper {
	if (is(table, Subquery)) {
		const alias = table._.alias

		if (table._.isWith) {
			return yql`${yql.raw(yqlBindingName(alias))} as ${yql.identifier(alias)}`
		}

		return yql`(${table._.sql}) as ${yql.identifier(alias)}`
	}

	if (is(table, Table) && (table as any)[(Table as any).Symbol.IsAlias]) {
		return yql`${yql.identifier((table as any)[(Table as any).Symbol.OriginalName])} ${yql.identifier((table as any)[(Table as any).Symbol.Name])}`
	}

	return table as SQLWrapper
}

export function buildJoins(joins: YdbJoinConfig[] | undefined): SQL | undefined {
	if (!joins || joins.length === 0) {
		return undefined
	}

	const joinsSql = joins.map((join) => {
		const onSql = join.on ? yql` on ${join.on}` : undefined
		const joinKeyword = yql.raw(`${join.joinType} join`)

		if (is(join.table, Table) && (join.table as any)[(Table as any).Symbol.IsAlias]) {
			return yql`${joinKeyword} ${yql.identifier((join.table as any)[(Table as any).Symbol.OriginalName])} ${yql.identifier((join.table as any)[(Table as any).Symbol.Name])}${onSql}`
		}

		return yql`${joinKeyword} ${join.table as SQLWrapper}${onSql}`
	})

	return yql` ${yql.join(joinsSql, yql` `)}`
}

export function buildOrderBy(orderBy: SQLWrapper[] | undefined): SQL | undefined {
	if (!orderBy || orderBy.length === 0) {
		return undefined
	}

	return yql` order by ${yql.join(
		orderBy.map((value) => yql`${value}`),
		yql`, `
	)}`
}

export function buildAssumeOrderBy(assumeOrderBy: SQLWrapper[] | undefined): SQL | undefined {
	if (!assumeOrderBy || assumeOrderBy.length === 0) {
		return undefined
	}

	return yql` assume order by ${yql.join(
		assumeOrderBy.map((value) => yql`${value}`),
		yql`, `
	)}`
}

export function buildLimit(limit: number | undefined): SQL | undefined {
	return limit !== undefined ? yql` limit ${limit}` : undefined
}

export function buildOffset(offset: number | undefined): SQL | undefined {
	return offset !== undefined ? yql` offset ${offset}` : undefined
}

function buildFlatten(flatten: YdbFlattenConfig | undefined): SQL | undefined {
	if (!flatten) {
		return undefined
	}

	if (flatten.mode === 'columns') {
		return yql` flatten columns`
	}

	if (!flatten.expressions || flatten.expressions.length === 0) {
		throw new Error('YDB flatten requires at least one expression')
	}

	return yql` flatten ${yql.raw(flatten.mode)} ${yql.join(
		flatten.expressions.map((value) => yql`${value}`),
		yql`, `
	)}`
}

function buildSample(sample: YdbSampleConfig | undefined): SQL | undefined {
	if (!sample) {
		return undefined
	}

	if (sample.kind === 'sample') {
		return yql` sample ${typeof sample.ratio === 'number' ? yql`${sample.ratio}` : sample.ratio}`
	}

	const repeatable =
		sample.repeatable === undefined
			? undefined
			: yql` repeatable(${typeof sample.repeatable === 'number' ? yql`${sample.repeatable}` : sample.repeatable})`

	return yql` tablesample ${yql.raw(sample.method)}(${typeof sample.size === 'number' ? yql`${sample.size}` : sample.size})${repeatable}`
}

function buildMatchRecognize(matchRecognize: YdbSelectConfig['matchRecognize']): SQL | undefined {
	if (!matchRecognize) {
		return undefined
	}

	return yql` match_recognize ${buildMatchRecognizeClause(matchRecognize)}`
}

function buildWindows(windows: YdbWindowClause[] | undefined): SQL | undefined {
	if (!windows || windows.length === 0) {
		return undefined
	}

	return yql` window ${yql.join(
		windows.map((window) => yql`${yql.identifier(window.name)} AS ${window.definition}`),
		yql`, `
	)}`
}

function buildSimpleSelectQuery(
	config: Omit<YdbSelectConfig, 'table' | 'fields' | 'fieldsFlat' | 'setOperators'> & {
		table?: unknown
		fieldsFlat: YdbSelectedFieldsOrdered
		extraSelections?: SQL[]
	}
): SQL {
	const selection =
		config.without && config.without.length > 0
			? buildSelectionWithout(config.without)
			: buildSelection(config.fieldsFlat, config.selectionAliases)
	const allSelections =
		config.extraSelections && config.extraSelections.length > 0
			? yql`${selection}, ${yql.join(config.extraSelections, yql`, `)}`
			: selection
	const joinsSql = buildJoins(config.joins)
	const whereSql = config.where ? yql` where ${config.where}` : undefined
	const groupBySql =
		config.groupBy && config.groupBy.length > 0
			? yql` ${yql.raw(config.groupByCompact ? 'group compact by' : 'group by')} ${yql.join(
					config.groupBy.map((value) => yql`${value}`),
					yql`, `
				)}`
			: undefined
	const havingSql = config.having ? yql` having ${config.having}` : undefined
	const windowSql = buildWindows(config.windows)
	const orderBySql = buildOrderBy(config.orderBy)
	const assumeOrderBySql = buildAssumeOrderBy(config.assumeOrderBy)
	const limitSql = buildLimit(config.limit)
	const offsetSql = buildOffset(config.offset)
	const intoResultSql = config.intoResult
		? yql` into result ${yql.identifier(config.intoResult)}`
		: undefined
	const uniqueDistinctSql =
		config.uniqueDistinctHints && config.uniqueDistinctHints.length > 0
			? yql` ${renderUniqueDistinctHints(config.uniqueDistinctHints)}`
			: undefined
	const distinctSql = config.distinct ? yql` distinct` : undefined
	const sampleSql = buildSample(config.sample)
	const matchRecognizeSql = buildMatchRecognize(config.matchRecognize)
	const flattenSql = buildFlatten(config.flatten)
	const fromSql =
		config.table === undefined
			? undefined
			: yql` from ${buildFromTable(config.table)}${sampleSql}${matchRecognizeSql}${flattenSql}`

	return yql`select${uniqueDistinctSql}${distinctSql} ${allSelections}${fromSql}${joinsSql}${whereSql}${groupBySql}${havingSql}${windowSql}${orderBySql}${assumeOrderBySql}${limitSql}${offsetSql}${intoResultSql}`
}

function buildDistinctOnQuery(
	config: YdbSelectConfig,
	fieldsFlat: YdbSelectedFieldsOrdered,
	selectionAliases: string[]
): SQL {
	if (!config.distinctOn || config.distinctOn.length === 0) {
		throw new Error('YDB distinctOn() requires at least one expression')
	}

	const distinctAlias = '__ydb_distinct_on'
	const rowNumberAlias = '__ydb_row_number'
	const rowNumberSelection = yql`row_number() over (
      partition by ${yql.join(
			config.distinctOn.map((value) => yql`${value}`),
			yql`, `
		)}
      ${buildOrderBy(config.orderBy)}
    ) as ${yql.identifier(rowNumberAlias)}`

	const innerQuery = buildSimpleSelectQuery({
		table: config.table,
		fieldsFlat,
		joins: config.joins,
		where: config.where,
		groupBy: config.groupBy,
		groupByCompact: config.groupByCompact,
		having: config.having,
		windows: config.windows,
		distinct: false,
		without: config.without,
		flatten: config.flatten,
		sample: config.sample,
		matchRecognize: config.matchRecognize,
		uniqueDistinctHints: config.uniqueDistinctHints,
		selectionAliases,
		extraSelections: [rowNumberSelection],
	})

	const outerOrderBy =
		config.orderBy && config.orderBy.length > 0
			? mapExpressionsToSelectionAliases(
					config.orderBy,
					fieldsFlat,
					selectionAliases,
					'distinctOn() orderBy()'
				)
			: undefined
	const selection = yql.join(
		selectionAliases.map((alias) => yql.identifier(alias)),
		yql`, `
	)
	const rowNumberFilter = yql`${qualifyIdentifier(distinctAlias, rowNumberAlias)} = 1`

	const intoResultSql = config.intoResult
		? yql` into result ${yql.identifier(config.intoResult)}`
		: undefined

	return yql`select ${selection} from (${innerQuery}) as ${yql.identifier(distinctAlias)} where ${rowNumberFilter}${buildOrderBy(outerOrderBy)}${buildLimit(config.limit)}${buildOffset(config.offset)}${intoResultSql}`
}

function buildEmulatedSetOperationQuery(
	type: 'intersect' | 'except',
	leftSelect: SQL,
	rightSelect: SQL,
	selectionAliases: string[],
	orderBy: SQLWrapper[] | undefined,
	limit: number | undefined,
	offset: number | undefined
): SQL {
	const leftAlias = '__ydb_left'
	const rightAlias = '__ydb_right'
	const matchAlias = '__ydb_match'
	const rightInputAlias = '__ydb_right_input'
	const rightSelection = yql.join(
		selectionAliases.map(
			(alias) => yql`${qualifyIdentifier(rightInputAlias, alias)} as ${yql.identifier(alias)}`
		),
		yql`, `
	)
	const rightComparable = yql`select ${rightSelection}, 1 as ${yql.identifier(matchAlias)} from (${rightSelect}) as ${yql.identifier(rightInputAlias)}`
	const joinConditions = selectionAliases.map((alias) => {
		const leftValue = qualifyIdentifier(leftAlias, alias)
		const rightValue = qualifyIdentifier(rightAlias, alias)
		return yql`${leftValue} = ${rightValue}`
	})
	const onSql = yql.join(joinConditions, yql` and `)
	const selection = yql.join(
		selectionAliases.map(
			(alias) => yql`${qualifyIdentifier(leftAlias, alias)} as ${yql.identifier(alias)}`
		),
		yql`, `
	)
	const joinSql =
		type === 'intersect'
			? yql`inner join (${rightComparable}) as ${yql.identifier(rightAlias)} on ${onSql}`
			: yql`left join (${rightComparable}) as ${yql.identifier(rightAlias)} on ${onSql}`
	const whereSql =
		type === 'except'
			? yql` where ${qualifyIdentifier(rightAlias, matchAlias)} is null`
			: undefined

	return yql`select distinct ${selection} from (${leftSelect}) as ${yql.identifier(leftAlias)} ${joinSql}${whereSql}${buildOrderBy(orderBy)}${buildLimit(limit)}${buildOffset(offset)}`
}

export function buildSetOperationQuery(
	leftSelect: SQL,
	fields: YdbSelectedFieldsOrdered,
	selectionAliases: string[],
	setOperator: YdbSetOperatorConfig
): SQL {
	const rightSelect = setOperator.rightSelect.getSQL(selectionAliases)
	const mappedOrderBy =
		setOperator.orderBy && setOperator.orderBy.length > 0
			? mapExpressionsToSelectionAliases(
					setOperator.orderBy,
					fields,
					selectionAliases,
					`${setOperator.type}() orderBy()`
				)
			: undefined

	if (setOperator.type === 'union') {
		const operator = yql.raw(`union${setOperator.isAll ? ' all' : ''}`)
		return yql`${leftSelect} ${operator} ${rightSelect}${buildOrderBy(mappedOrderBy)}${buildLimit(setOperator.limit)}${buildOffset(setOperator.offset)}`
	}

	return buildEmulatedSetOperationQuery(
		setOperator.type,
		leftSelect,
		rightSelect,
		selectionAliases,
		mappedOrderBy,
		setOperator.limit,
		setOperator.offset
	)
}

export function buildSetOperations(
	leftSelect: SQL,
	fields: YdbSelectedFieldsOrdered,
	selectionAliases: string[],
	setOperators: YdbSetOperatorConfig[]
): SQL {
	return setOperators.reduce(
		(current, setOperator) =>
			buildSetOperationQuery(current, fields, selectionAliases, setOperator),
		leftSelect
	)
}

export function buildSelectQuery(config: YdbSelectConfig): SQL {
	const fieldsFlat = config.fieldsFlat ?? orderSelectedFields(config.fields)
	const selectionAliases = config.selectionAliases
	const baseQuery =
		config.distinctOn && config.distinctOn.length > 0
			? buildDistinctOnQuery(
					config,
					fieldsFlat,
					selectionAliases ?? getSelectionAliases(fieldsFlat)
				)
			: buildSimpleSelectQuery({
					table: config.table,
					fieldsFlat,
					joins: config.joins,
					where: config.where,
					groupBy: config.groupBy,
					groupByCompact: config.groupByCompact,
					having: config.having,
					windows: config.windows,
					orderBy: config.orderBy,
					assumeOrderBy: config.assumeOrderBy,
					limit: config.limit,
					offset: config.offset,
					intoResult: config.intoResult,
					without: config.without,
					flatten: config.flatten,
					sample: config.sample,
					matchRecognize: config.matchRecognize,
					uniqueDistinctHints: config.uniqueDistinctHints,
					distinct: config.distinct,
					selectionAliases,
				})

	if (config.setOperators.length === 0) {
		return baseQuery
	}

	return buildSetOperations(
		baseQuery,
		fieldsFlat,
		selectionAliases ?? getSelectionAliases(fieldsFlat),
		config.setOperators
	)
}
