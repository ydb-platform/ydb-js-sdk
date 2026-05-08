import { entityKind, is } from 'drizzle-orm/entity'
import { Column } from 'drizzle-orm/column'
import { QueryPromise } from 'drizzle-orm/query-promise'
import { SQL, type SQLWrapper, sql as yql } from 'drizzle-orm/sql/sql'
import type { Subquery } from 'drizzle-orm/subquery'
import { haveSameKeys } from 'drizzle-orm/utils'
import { mapResultRow, orderSelectedFields } from '../result-mapping.js'
import type { YdbPreparedQueryConfig, YdbSession } from '../session.js'
import { YdbDialect } from '../../ydb/dialect.js'
import type {
	YdbJoinType,
	YdbSelectConfig,
	YdbSetOperatorConfig,
	YdbSetOperatorSource,
} from '../../ydb/dialect.types.js'
import { getSetOperatorHelpers } from './select.set-operators.js'
import type {
	SelectConfigWithTable,
	SelectFields,
	YdbSelectBuilderOptions,
} from './select.types.js'
import {
	createSelectionProxy,
	getSourceSelection,
	getTableLikeName,
	normalizeCountValue,
	normalizeSqlWrapperArray,
} from './select.utils.js'
import {
	type YdbFlattenMode,
	type YdbMatchRecognizeConfig,
	type YdbUniqueDistinctHint,
	type YdbValuesOptions,
	type YdbValuesRow,
	type YdbWindowClause,
	type YdbWindowDefinitionConfig,
	asTable,
	valuesTable,
	windowDefinition,
} from './select-syntax.js'

type SelectionCallback = (fields: any) => SQLWrapper | SQLWrapper[]

export class YdbSelectBuilder<TResult = unknown[]>
	extends QueryPromise<TResult>
	implements YdbSetOperatorSource
{
	static override readonly [entityKind] = 'YdbSelectBuilder'

	private readonly session: YdbSession | undefined
	private readonly dialect: YdbDialect
	private readonly config: Omit<YdbSelectConfig, 'table'> & { table?: unknown }
	private readonly isPartialSelect: boolean
	private joinsNotNullableMap: Record<string, boolean> = {}
	private tableName: string | undefined
	private usedInSetOperation = false

	constructor(session: YdbSession | undefined, fields?: SelectFields)
	constructor(
		session: YdbSession | undefined,
		dialect: YdbDialect,
		fields?: SelectFields,
		options?: YdbSelectBuilderOptions,
		withList?: Subquery[]
	)
	constructor(
		session: YdbSession | undefined,
		dialectOrFields?: YdbDialect | SelectFields,
		fieldsOrUndefined?: SelectFields,
		options: YdbSelectBuilderOptions = {},
		withList: Subquery[] = []
	) {
		super()
		this.session = session

		if (dialectOrFields instanceof YdbDialect) {
			this.dialect = dialectOrFields
			this.isPartialSelect = fieldsOrUndefined !== undefined
			this.config = {
				table: undefined,
				fields: fieldsOrUndefined ? { ...fieldsOrUndefined } : {},
				withList,
				distinct: options.distinct,
				distinctOn: options.distinctOn,
				setOperators: [],
			}
			return
		}

		this.dialect = new YdbDialect()
		this.isPartialSelect = dialectOrFields !== undefined
		this.config = {
			table: undefined,
			fields: dialectOrFields ? { ...(dialectOrFields as SelectFields) } : {},
			withList,
			distinct: false,
			distinctOn: undefined,
			setOperators: [],
		}
	}

	private requireTable(): unknown | undefined {
		if (this.config.table === undefined && Object.keys(this.config.fields).length === 0) {
			throw new Error('Missing table in select().from()')
		}

		return this.config.table
	}

	private requireConfigWithTable(): SelectConfigWithTable {
		const table = this.requireTable()

		if (Object.keys(this.config.fields).length === 0) {
			throw new Error('YDB select() selected zero columns')
		}

		return {
			...this.config,
			table,
		}
	}

	private requireSession(): YdbSession {
		if (!this.session) {
			throw new Error(
				'Cannot execute a query on a query builder. Please use a database instance instead.'
			)
		}

		return this.session
	}

	private markUsedInSetOperation(): void {
		this.usedInSetOperation = true
	}

	private shouldUseSelectionAliases(): boolean {
		return (
			this.usedInSetOperation ||
			(this.config.joins?.length ?? 0) > 0 ||
			(this.config.distinctOn?.length ?? 0) > 0
		)
	}

	private getOrderedFields() {
		return orderSelectedFields(this.getSelectedFields())
	}

	private getSelectionAliases(fields = this.getOrderedFields()): string[] | undefined {
		return this.shouldUseSelectionAliases()
			? this.dialect.getSelectionAliases(fields)
			: undefined
	}

	private getTargetConfigForTailClauses():
		| YdbSetOperatorConfig
		| (Omit<YdbSelectConfig, 'table'> & { table?: unknown }) {
		return this.config.setOperators[this.config.setOperators.length - 1] ?? this.config
	}

	private createJoin(joinType: YdbJoinType) {
		return (table: unknown, on?: SQL | ((fields: SelectFields) => SQL)) => {
			if (this.config.without && this.config.without.length > 0) {
				throw new Error('YDB without() cannot be combined with joins')
			}

			const baseTableName = this.tableName
			const tableName = getTableLikeName(table)

			if (
				typeof tableName === 'string' &&
				this.config.joins?.some((join) => join.alias === tableName)
			) {
				throw new Error(`Alias "${tableName}" is already used in this query`)
			}

			if (!this.isPartialSelect) {
				if (
					Object.keys(this.joinsNotNullableMap).length === 1 &&
					typeof baseTableName === 'string'
				) {
					this.config.fields = {
						[baseTableName]: this.config.fields,
					}
				}

				if (typeof tableName === 'string' && !is(table, SQL)) {
					this.config.fields[tableName] = getSourceSelection(table)
				}
			}

			const resolvedOn =
				typeof on === 'function' ? on(createSelectionProxy(this.config.fields, 'sql')) : on

			if (!this.config.joins) {
				this.config.joins = []
			}

			this.config.joins.push({
				table,
				joinType,
				alias: tableName,
				on: resolvedOn,
			})

			if (typeof tableName === 'string') {
				switch (joinType) {
					case 'left':
						this.joinsNotNullableMap[tableName] = false
						break
					case 'right':
						this.joinsNotNullableMap = Object.fromEntries(
							Object.keys(this.joinsNotNullableMap).map((key) => [key, false])
						)
						this.joinsNotNullableMap[tableName] = true
						break
					case 'full':
						this.joinsNotNullableMap = Object.fromEntries(
							Object.keys(this.joinsNotNullableMap).map((key) => [key, false])
						)
						this.joinsNotNullableMap[tableName] = false
						break
					case 'inner':
					case 'cross':
						this.joinsNotNullableMap[tableName] = true
						break
				}
			}

			return this
		}
	}

	private applyWithoutToFields(values: readonly (string | SQLWrapper)[]): void {
		if (Object.keys(this.config.fields).length === 0) {
			return
		}

		const fieldEntries = Object.entries(this.config.fields)
		const removedKeys = new Set<string>()
		const removedColumnNames = new Set<string>()

		for (const value of values) {
			if (typeof value === 'string') {
				removedKeys.add(value)
				removedColumnNames.add(value)
				continue
			}

			if (is(value, Column)) {
				removedColumnNames.add(value.name)
			}
		}

		this.config.fields = Object.fromEntries(
			fieldEntries.filter(([key, field]) => {
				if (removedKeys.has(key)) {
					return false
				}

				return !(is(field, Column) && removedColumnNames.has(field.name))
			})
		)
	}

	private normalizeWithout(values: readonly (string | SQLWrapper)[]): SQLWrapper[] {
		if (values.length === 0) {
			throw new Error('YDB without() requires at least one column')
		}

		return values.map((value) => {
			if (typeof value === 'string') {
				return yql.identifier(value)
			}

			if (is(value, Column)) {
				return yql.identifier(value.name)
			}

			return value
		})
	}

	private setFlatten(mode: YdbFlattenMode, expressions: readonly SQLWrapper[] = []): this {
		if (mode !== 'columns' && expressions.length === 0) {
			throw new Error('YDB flatten requires at least one expression')
		}

		this.config.flatten = {
			mode,
			expressions: expressions.length > 0 ? [...expressions] : undefined,
		}
		return this
	}

	private normalizeColumnExpressions(
		values: readonly (string | SQLWrapper)[],
		context: string
	): SQLWrapper[] {
		if (values.length === 0) {
			throw new Error(`YDB ${context} requires at least one column`)
		}

		return values.map((value) => {
			if (typeof value === 'string') {
				return yql.identifier(value)
			}

			if (is(value, Column)) {
				return yql.identifier(value.name)
			}

			return value
		})
	}

	private createSetOperator(type: 'union' | 'intersect' | 'except', isAll: boolean) {
		return (
			rightSelection:
				| YdbSetOperatorSource
				| ((operators: ReturnType<typeof getSetOperatorHelpers>) => YdbSetOperatorSource)
		) => {
			const rightSelect =
				typeof rightSelection === 'function'
					? rightSelection(getSetOperatorHelpers())
					: rightSelection

			if (!haveSameKeys(this.getSelectedFields(), rightSelect.getSelectedFields())) {
				throw new Error(
					'Set operator error (union / intersect / except): selected fields are not the same or are in a different order'
				)
			}

			this.markUsedInSetOperation()
			if (
				'markUsedInSetOperation' in rightSelect &&
				typeof (rightSelect as any).markUsedInSetOperation === 'function'
			) {
				;(rightSelect as any).markUsedInSetOperation()
			}

			this.config.setOperators.push({
				type,
				isAll,
				rightSelect,
			})

			return this
		}
	}

	from(source: unknown): this {
		this.config.table = source
		this.tableName = getTableLikeName(source)

		if (!this.isPartialSelect) {
			this.config.fields = getSourceSelection(source)
			if (this.config.without && this.config.without.length > 0) {
				this.applyWithoutToFields(this.config.without)
			}
		}

		this.joinsNotNullableMap =
			typeof this.tableName === 'string' ? { [this.tableName]: true } : {}
		return this
	}

	fromAsTable(binding: string | SQLWrapper, alias?: string): this {
		return this.from(asTable(binding, alias))
	}

	fromValues(rows: readonly YdbValuesRow[], options?: YdbValuesOptions): this {
		return this.from(valuesTable(rows, options))
	}

	getSelectedFields(): SelectFields {
		return this.config.fields
	}

	where(where: SQL | ((fields: SelectFields) => SQL) | undefined): this {
		this.config.where =
			typeof where === 'function'
				? where(createSelectionProxy(this.config.fields, 'sql'))
				: (where ?? undefined)
		return this
	}

	having(having: SQL | ((fields: SelectFields) => SQL) | undefined): this {
		this.config.having =
			typeof having === 'function'
				? having(createSelectionProxy(this.config.fields, 'sql'))
				: (having ?? undefined)
		return this
	}

	groupBy(...columns: SQLWrapper[] | [SelectionCallback]): this {
		if (typeof columns[0] === 'function') {
			const groupBy = columns[0](createSelectionProxy(this.config.fields, 'alias'))
			this.config.groupBy = Array.isArray(groupBy) ? groupBy : [groupBy]
			this.config.groupByCompact = false
			return this
		}

		this.config.groupBy = columns as SQLWrapper[]
		this.config.groupByCompact = false
		return this
	}

	groupCompactBy(...columns: SQLWrapper[] | [SelectionCallback]): this {
		if (typeof columns[0] === 'function') {
			const groupBy = columns[0](createSelectionProxy(this.config.fields, 'alias'))
			this.config.groupBy = Array.isArray(groupBy) ? groupBy : [groupBy]
			this.config.groupByCompact = true
			return this
		}

		this.config.groupBy = columns as SQLWrapper[]
		this.config.groupByCompact = true
		return this
	}

	orderBy(...columns: SQLWrapper[] | [SelectionCallback]): this {
		const target = this.getTargetConfigForTailClauses()

		if (target === this.config && this.config.assumeOrderBy?.length) {
			throw new Error('YDB orderBy() cannot be combined with assumeOrderBy()')
		}

		if (typeof columns[0] === 'function') {
			const orderBy = columns[0](createSelectionProxy(this.config.fields, 'alias'))
			;(target as YdbSetOperatorConfig | typeof this.config).orderBy = Array.isArray(orderBy)
				? orderBy
				: [orderBy]
			return this
		}

		;(target as YdbSetOperatorConfig | typeof this.config).orderBy = columns as SQLWrapper[]
		return this
	}

	assumeOrderBy(...columns: (string | SQLWrapper)[] | [(string | SQLWrapper)[]]): this {
		if (this.config.orderBy && this.config.orderBy.length > 0) {
			throw new Error('YDB assumeOrderBy() cannot be combined with orderBy()')
		}

		const resolved = Array.isArray(columns[0])
			? (columns[0] as (string | SQLWrapper)[])
			: (columns as (string | SQLWrapper)[])
		this.config.assumeOrderBy = this.normalizeColumnExpressions(resolved, 'assumeOrderBy()')
		return this
	}

	limit(limit: number): this {
		const target = this.getTargetConfigForTailClauses()
		;(target as YdbSetOperatorConfig | typeof this.config).limit = normalizeCountValue(
			limit,
			'limit'
		)
		return this
	}

	offset(offset: number): this {
		const target = this.getTargetConfigForTailClauses()
		;(target as YdbSetOperatorConfig | typeof this.config).offset = normalizeCountValue(
			offset,
			'offset'
		)
		return this
	}

	without(...columns: (string | SQLWrapper)[] | [(string | SQLWrapper)[]]): this {
		if (this.config.table === undefined) {
			throw new Error('YDB without() must be called after from()')
		}

		if (this.config.joins && this.config.joins.length > 0) {
			throw new Error('YDB without() cannot be combined with joins')
		}

		if (this.isPartialSelect) {
			throw new Error('YDB without() is only supported for whole-source select() queries')
		}

		if (this.config.distinctOn && this.config.distinctOn.length > 0) {
			throw new Error('YDB without() cannot be combined with distinctOn()')
		}

		const resolved = Array.isArray(columns[0])
			? (columns[0] as (string | SQLWrapper)[])
			: (columns as (string | SQLWrapper)[])
		this.config.without = this.normalizeWithout(resolved)
		this.applyWithoutToFields(resolved)
		return this
	}

	flattenBy(...expressions: SQLWrapper[]): this {
		return this.setFlatten('by', expressions)
	}

	flattenListBy(...expressions: SQLWrapper[]): this {
		return this.setFlatten('list by', expressions)
	}

	flattenDictBy(...expressions: SQLWrapper[]): this {
		return this.setFlatten('dict by', expressions)
	}

	flattenOptionalBy(...expressions: SQLWrapper[]): this {
		return this.setFlatten('optional by', expressions)
	}

	flattenColumns(): this {
		return this.setFlatten('columns')
	}

	sample(ratio: number | SQLWrapper): this {
		if (typeof ratio === 'number') {
			normalizeCountValue(ratio, 'sample')
		}

		this.config.sample = { kind: 'sample', ratio }
		return this
	}

	tableSample(method: string, size: number | SQLWrapper, repeatable?: number | SQLWrapper): this {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(method)) {
			throw new Error('YDB tableSample() method must be a simple identifier')
		}
		if (typeof size === 'number') {
			normalizeCountValue(size, 'tableSample')
		}
		if (typeof repeatable === 'number') {
			normalizeCountValue(repeatable, 'tableSample repeatable')
		}

		this.config.sample = { kind: 'tablesample', method, size, repeatable }
		return this
	}

	matchRecognize(config: YdbMatchRecognizeConfig | SQLWrapper): this {
		this.config.matchRecognize = config
		return this
	}

	window(name: string, definition: YdbWindowDefinitionConfig | SQLWrapper): this {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
			throw new Error('YDB window() name must be a simple identifier')
		}

		const windows = this.config.windows ?? []
		if (windows.some((value: YdbWindowClause) => value.name === name)) {
			throw new Error(`YDB window() duplicate window name "${name}"`)
		}

		this.config.windows = [...windows, { name, definition: windowDefinition(definition) }]
		return this
	}

	intoResult(name: string): this {
		this.config.intoResult = name
		return this
	}

	uniqueDistinct(...hints: YdbUniqueDistinctHint[] | [YdbUniqueDistinctHint[]]): this {
		const resolved = Array.isArray(hints[0])
			? (hints[0] as YdbUniqueDistinctHint[])
			: (hints as YdbUniqueDistinctHint[])
		if (resolved.length === 0) {
			throw new Error('YDB uniqueDistinct() requires at least one hint')
		}

		this.config.uniqueDistinctHints = [...(this.config.uniqueDistinctHints ?? []), ...resolved]
		return this
	}

	distinct(): this {
		if (this.config.distinctOn && this.config.distinctOn.length > 0) {
			throw new Error('YDB select() cannot combine distinct() and distinctOn()')
		}

		this.config.distinct = true
		return this
	}

	distinctOn(...values: SQLWrapper[] | [SQLWrapper[]]): this {
		if (this.config.distinct) {
			throw new Error('YDB select() cannot combine distinct() and distinctOn()')
		}

		const resolved = Array.isArray(values[0])
			? normalizeSqlWrapperArray(values[0] as SQLWrapper[])
			: normalizeSqlWrapperArray(values as SQLWrapper[])
		if (!resolved || resolved.length === 0) {
			throw new Error('YDB distinctOn() requires at least one expression')
		}

		this.config.distinctOn = resolved
		return this
	}

	innerJoin = this.createJoin('inner')
	leftJoin = this.createJoin('left')
	rightJoin = this.createJoin('right')
	fullJoin = this.createJoin('full')
	crossJoin = this.createJoin('cross')
	leftSemiJoin = this.createJoin('left semi')
	rightSemiJoin = this.createJoin('right semi')
	leftOnlyJoin = this.createJoin('left only')
	rightOnlyJoin = this.createJoin('right only')
	exclusionJoin = this.createJoin('exclusion')

	union = this.createSetOperator('union', false)
	unionAll = this.createSetOperator('union', true)
	intersect = this.createSetOperator('intersect', false)
	except = this.createSetOperator('except', false)

	addSetOperators(setOperators: YdbSetOperatorConfig[]): this {
		this.markUsedInSetOperation()

		for (const setOperator of setOperators) {
			if (
				'markUsedInSetOperation' in setOperator.rightSelect &&
				typeof (setOperator.rightSelect as any).markUsedInSetOperation === 'function'
			) {
				;(setOperator.rightSelect as any).markUsedInSetOperation()
			}
		}

		this.config.setOperators.push(...setOperators)
		return this
	}

	getSQL(selectionAliases?: string[]): SQL {
		const config = this.requireConfigWithTable()
		const fieldsFlat = orderSelectedFields(config.fields)
		const aliases = selectionAliases ?? this.getSelectionAliases(fieldsFlat)

		return this.dialect.buildSelectQuery({
			...config,
			fieldsFlat,
			selectionAliases: aliases,
		})
	}

	toSQL() {
		const { typings: _typings, ...query } = this.dialect.sqlToQuery(this.getSQL())
		return query
	}

	prepare(name?: string) {
		const session = this.requireSession()
		const orderedFields = this.getOrderedFields()
		const joinsNotNullableMap =
			Object.keys(this.joinsNotNullableMap).length > 0 ? this.joinsNotNullableMap : undefined
		const resultMapper = (rows: unknown[][]) =>
			rows.map((row) => mapResultRow(orderedFields, row, joinsNotNullableMap))

		return session.prepareQuery<YdbPreparedQueryConfig & { execute: TResult; all: TResult }>(
			this.getSQL(),
			orderedFields,
			name,
			true,
			resultMapper as any
		)
	}

	override execute(): Promise<TResult> {
		return this.prepare().execute() as Promise<TResult>
	}
}
