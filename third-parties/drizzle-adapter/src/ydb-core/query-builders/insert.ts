import { is } from 'drizzle-orm/entity'
import { QueryPromise } from 'drizzle-orm/query-promise'
import { Param, SQL, type SQL as SQLType, sql as yql } from 'drizzle-orm/sql/sql'
import type { Subquery } from 'drizzle-orm/subquery'
import { Table } from 'drizzle-orm/table'
import { haveSameKeys } from 'drizzle-orm/utils'
import type { YdbPreparedQueryConfig, YdbSession } from '../session.js'
import type { YdbTable } from '../table.js'
import type { YdbColumn } from '../columns/common.js'
import { type YdbSelectedFieldsOrdered, orderSelectedFields } from '../result-mapping.js'
import { YdbDialect } from '../../ydb/dialect.js'
import {
	getInsertColumnEntries,
	getPrimaryColumnKeys,
	getTableColumns,
	resolveInsertValue,
	validateTableColumnKeys,
} from './utils.js'
import { YdbQueryBuilder } from './query-builder.js'

type InsertValues = Record<string, unknown>
type OnDuplicateKeyUpdateConfig = { set: InsertValues }
type InsertCommand = 'insert' | 'upsert' | 'replace'
type InsertSelectQuery =
	| SQLType
	| {
			getSQL(): SQLType
			getSelectedFields(): Record<string, unknown> | undefined
	  }

function qualifyAlias(alias: string, columnName: string): SQLType {
	return yql`${yql.identifier(alias)}.${yql.identifier(columnName)}`
}

function resolveOnDuplicateValue(column: YdbColumn, value: unknown): unknown {
	return is(value, SQL) || is(value, Param) ? value : yql.param(value, column)
}

function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1)
}

function getAllReturningFields(table: YdbTable): Record<string, unknown> {
	return (table as any)[(Table as any).Symbol.Columns] ?? {}
}

function getProvidedColumnEntries(
	table: YdbTable,
	rows: InsertValues[],
	command: InsertCommand
): Array<[string, YdbColumn]> {
	const firstRow = rows[0] ?? {}
	const firstKeys = Object.keys(firstRow)
	if (firstKeys.length === 0) {
		throw new Error(`YDB ${command} values must include at least one column`)
	}

	for (const row of rows) {
		validateTableColumnKeys(table, row, command)
		if (!haveSameKeys(firstRow, row)) {
			throw new Error(`YDB ${command} values must provide the same columns for every row`)
		}
	}

	const keys = new Set(firstKeys)
	return getInsertColumnEntries(table).filter(([key]) => keys.has(key))
}

function hasRuntimeInsertValue(column: YdbColumn): boolean {
	return (
		column.defaultFn !== undefined ||
		column.default !== undefined ||
		column.onUpdateFn !== undefined
	)
}

function getDefaultAwareInsertColumnEntries(
	table: YdbTable,
	rows: InsertValues[]
): Array<[string, YdbColumn]> {
	const explicitKeys = new Set<string>()
	for (const row of rows) {
		validateTableColumnKeys(table, row, 'insert')
		for (const key of Object.keys(row)) {
			explicitKeys.add(key)
		}
	}

	const entries = getInsertColumnEntries(table).filter(
		([key, column]) => explicitKeys.has(key) || hasRuntimeInsertValue(column)
	)

	for (const row of rows) {
		for (const [key, column] of entries) {
			if (!(key in row) && !hasRuntimeInsertValue(column)) {
				throw new Error(
					'YDB insert values must provide the same non-default columns for every row'
				)
			}
		}
	}

	return entries
}

function getSelectColumnEntries(
	table: YdbTable,
	fields: Record<string, unknown> | undefined,
	command: InsertCommand
): Array<[string, YdbColumn]> {
	const selectedKeys = Object.keys(fields ?? {})
	if (selectedKeys.length === 0) {
		throw new Error(
			'Insert select error: selected fields must include at least one table column'
		)
	}

	const columns = getTableColumns(table)
	const insertableColumns = new Map(getInsertColumnEntries(table))
	for (const key of selectedKeys) {
		if (!(key in columns)) {
			throw new Error(
				`Insert select error: selected field "${key}" is not a column of the target table`
			)
		}

		if (!insertableColumns.has(key)) {
			throw new Error(
				`Insert select error: selected field "${key}" is not insertable in ${command}()`
			)
		}
	}

	return selectedKeys.map((key) => [key, insertableColumns.get(key)!])
}

abstract class YdbInsertLikeBuilder<TResult = unknown> extends QueryPromise<TResult> {
	protected valuesData: InsertValues | InsertValues[] | undefined
	protected selectQuery: InsertSelectQuery | undefined
	protected selectColumnEntries: Array<[string, YdbColumn]> | undefined
	protected returningFields: YdbSelectedFieldsOrdered | undefined

	constructor(
		protected readonly table: YdbTable,
		protected readonly session: YdbSession,
		protected readonly dialect: YdbDialect,
		protected readonly withList: Subquery[],
		protected readonly command: InsertCommand,
		private readonly valuesColumnMode: 'all' | 'provided' | 'default-aware'
	) {
		super()
	}

	values(values: InsertValues | InsertValues[]): this {
		this.valuesData = values
		this.selectQuery = undefined
		this.selectColumnEntries = undefined
		return this
	}

	select(query: InsertSelectQuery | ((qb: YdbQueryBuilder) => InsertSelectQuery)): this {
		const resolved =
			typeof query === 'function' ? query(new YdbQueryBuilder(this.dialect)) : query

		this.selectQuery = resolved
		this.selectColumnEntries = is(resolved, SQL)
			? undefined
			: getSelectColumnEntries(this.table, resolved.getSelectedFields(), this.command)
		this.valuesData = undefined
		return this
	}

	protected setReturning(fields: Record<string, unknown>): this {
		const orderedFields = orderSelectedFields(fields)
		if (orderedFields.length === 0) {
			throw new Error('YDB returning() requires at least one field')
		}

		this.returningFields = orderedFields
		return this
	}

	protected getRows(): InsertValues[] {
		if (!this.valuesData) {
			throw new Error(`${capitalize(this.command)} values are missing`)
		}

		const rows = Array.isArray(this.valuesData) ? this.valuesData : [this.valuesData]
		if (rows.length === 0) {
			throw new Error(`${capitalize(this.command)} values are empty`)
		}

		for (const row of rows) {
			validateTableColumnKeys(this.table, row, this.command)
		}

		return rows
	}

	protected buildStandardQuery(): SQLType {
		if (this.selectQuery) {
			return this.dialect.buildInsertQuery({
				table: this.table,
				values: this.selectQuery,
				select: true,
				withList: this.withList,
				command: this.command,
				columnEntries: this.selectColumnEntries,
				returning: this.returningFields,
			})
		}

		const rows = this.getRows()
		const columnEntries =
			this.valuesColumnMode === 'all'
				? getInsertColumnEntries(this.table)
				: this.valuesColumnMode === 'default-aware'
					? getDefaultAwareInsertColumnEntries(this.table, rows)
					: getProvidedColumnEntries(this.table, rows, this.command)

		return this.dialect.buildInsertQuery({
			table: this.table,
			values: rows,
			withList: this.withList,
			command: this.command,
			columnEntries,
			returning: this.returningFields,
		})
	}

	getSQL(): SQLType {
		return this.buildStandardQuery()
	}

	toSQL() {
		const { typings: _typings, ...query } = this.dialect.sqlToQuery(this.getSQL())
		return query
	}

	prepare(name?: string) {
		return this.session.prepareQuery<YdbPreparedQueryConfig & { execute: TResult }>(
			this.getSQL(),
			this.returningFields,
			name,
			this.returningFields !== undefined
		)
	}

	override execute(): Promise<TResult> {
		return this.prepare().execute() as Promise<TResult>
	}
}

export class YdbInsertBuilder<TResult = unknown> extends YdbInsertLikeBuilder<TResult> {
	private onDuplicateSet: InsertValues | undefined

	constructor(
		table: YdbTable,
		session: YdbSession,
		dialect = new YdbDialect(),
		withList: Subquery[] = []
	) {
		super(table, session, dialect, withList, 'insert', 'default-aware')
	}

	returning(fields: Record<string, unknown> = getAllReturningFields(this.table)): this {
		return this.setReturning(fields)
	}

	onDuplicateKeyUpdate(config: OnDuplicateKeyUpdateConfig): this {
		validateTableColumnKeys(this.table, config.set, 'update')
		this.onDuplicateSet = { ...config.set }
		return this
	}

	private buildOnDuplicateKeyUpdateQuery(rows: InsertValues[]): SQLType {
		if (this.selectQuery) {
			throw new Error('YDB onDuplicateKeyUpdate() does not support insert().select(...)')
		}

		const columnEntries = getInsertColumnEntries(this.table)
		if (columnEntries.length === 0) {
			throw new Error('Insertable columns are missing')
		}

		const columnsByKey = new Map(columnEntries)
		const primaryColumns = getPrimaryColumnKeys(this.table)
			.map((key) => columnsByKey.get(key))
			.filter((column): column is YdbColumn => column !== undefined)
		const primaryColumnSet = new Set(primaryColumns)

		if (primaryColumns.length === 0) {
			throw new Error('YDB onDuplicateKeyUpdate() requires at least one primary key column')
		}

		const incomingAlias = '__ydb_incoming'
		const incomingSql = yql.join(
			rows.map(
				(row) =>
					yql`select ${yql.join(
						columnEntries.map(
							([key, column]) =>
								yql`${resolveInsertValue(column, row[key])} as ${yql.identifier(column.name)}`
						),
						yql`, `
					)}`
			),
			yql` union all `
		)

		const conflictDetectedSql = yql`${this.table}.${yql.identifier(primaryColumns[0]!.name)}`
		const mergedSelections = yql.join(
			columnEntries.map(([key, column]) => {
				if (primaryColumnSet.has(column)) {
					return yql`${qualifyAlias(incomingAlias, column.name)} as ${yql.identifier(column.name)}`
				}

				if (this.onDuplicateSet && key in this.onDuplicateSet) {
					return yql`case when ${conflictDetectedSql} is null then ${qualifyAlias(
						incomingAlias,
						column.name
					)} else ${resolveOnDuplicateValue(column, this.onDuplicateSet[key])} end as ${yql.identifier(column.name)}`
				}

				return yql`case when ${conflictDetectedSql} is null then ${qualifyAlias(
					incomingAlias,
					column.name
				)} else ${column} end as ${yql.identifier(column.name)}`
			}),
			yql`, `
		)

		const joinSql = yql.join(
			primaryColumns.map(
				(column) => yql`${column} = ${qualifyAlias(incomingAlias, column.name)}`
			),
			yql` and `
		)
		const columnList = yql.join(
			columnEntries.map(([, column]) => yql.identifier(column.name)),
			yql`, `
		)
		const withSql = this.dialect.buildWithCTE([
			...this.withList,
			{ _: { alias: incomingAlias, sql: incomingSql } } as any,
		])
		const returningSql = this.returningFields
			? yql` returning ${this.dialect.buildReturningSelection(this.returningFields)}`
			: undefined

		return yql`${withSql}upsert into ${this.table} (${columnList}) select ${mergedSelections} from ${yql.raw(
			`$${incomingAlias}`
		)} as ${yql.identifier(incomingAlias)} left join ${this.table} on ${joinSql}${returningSql}`
	}

	override getSQL(): SQLType {
		if (this.onDuplicateSet) {
			if (this.selectQuery) {
				return this.buildOnDuplicateKeyUpdateQuery([])
			}

			const rows = this.getRows()
			return this.buildOnDuplicateKeyUpdateQuery(rows)
		}

		return this.buildStandardQuery()
	}
}

export class YdbUpsertBuilder<TResult = unknown> extends YdbInsertLikeBuilder<TResult> {
	constructor(
		table: YdbTable,
		session: YdbSession,
		dialect = new YdbDialect(),
		withList: Subquery[] = []
	) {
		super(table, session, dialect, withList, 'upsert', 'provided')
	}

	returning(fields: Record<string, unknown> = getAllReturningFields(this.table)): this {
		return this.setReturning(fields)
	}
}

export class YdbReplaceBuilder<TResult = unknown> extends YdbInsertLikeBuilder<TResult> {
	constructor(
		table: YdbTable,
		session: YdbSession,
		dialect = new YdbDialect(),
		withList: Subquery[] = []
	) {
		super(table, session, dialect, withList, 'replace', 'all')
	}

	returning(): never {
		throw new Error('YDB replace().returning() is not documented or supported')
	}
}
