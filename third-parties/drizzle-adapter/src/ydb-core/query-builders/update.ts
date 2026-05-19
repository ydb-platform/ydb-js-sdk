import { is } from 'drizzle-orm/entity'
import { QueryPromise } from 'drizzle-orm/query-promise'
import { SQL, type SQL as SQLType, sql as yql } from 'drizzle-orm/sql/sql'
import type { Subquery } from 'drizzle-orm/subquery'
import { Table } from 'drizzle-orm/table'
import type { YdbPreparedQueryConfig, YdbSession } from '../session.js'
import type { YdbTable } from '../table.js'
import { type YdbSelectedFieldsOrdered, orderSelectedFields } from '../result-mapping.js'
import { YdbDialect } from '../../ydb/dialect.js'
import {
	getTableColumns,
	resolveUpdateValue,
	validateSetBasedMutationSelection,
	validateTableColumnKeys,
} from './utils.js'
import { YdbQueryBuilder } from './query-builder.js'

type UpdateValues = Record<string, unknown>
type UpdateOnQuery =
	| SQLType
	| {
			getSQL(): SQLType
			getSelectedFields(): Record<string, unknown> | undefined
	  }

function getAllReturningFields(table: YdbTable): Record<string, unknown> {
	return (table as any)[(Table as any).Symbol.Columns] ?? {}
}

export class YdbUpdateBuilder<TResult = unknown> extends QueryPromise<TResult> {
	private valuesData: UpdateValues | undefined
	private whereClause: SQLType | undefined
	private onQuery: UpdateOnQuery | undefined
	private returningFields: YdbSelectedFieldsOrdered | undefined

	constructor(
		private readonly table: YdbTable,
		private readonly session: YdbSession,
		private readonly dialect = new YdbDialect(),
		private readonly withList: Subquery[] = []
	) {
		super()
	}

	set(values: UpdateValues): this {
		this.valuesData = values
		this.onQuery = undefined
		return this
	}

	where(where: SQLType | undefined): this {
		if (this.onQuery) {
			throw new Error('YDB update().on() does not support where()')
		}

		this.whereClause = where ?? undefined
		return this
	}

	on(query: UpdateOnQuery | ((qb: YdbQueryBuilder) => UpdateOnQuery)): this {
		const resolved =
			typeof query === 'function' ? query(new YdbQueryBuilder(this.dialect)) : query

		if (!is(resolved, SQL)) {
			validateSetBasedMutationSelection(this.table, resolved.getSelectedFields(), 'update')
		}

		this.onQuery = resolved
		this.valuesData = undefined
		this.whereClause = undefined
		return this
	}

	returning(fields: Record<string, unknown> = getAllReturningFields(this.table)): this {
		const orderedFields = orderSelectedFields(fields)
		if (orderedFields.length === 0) {
			throw new Error('YDB returning() requires at least one field')
		}

		this.returningFields = orderedFields
		return this
	}

	getSQL(): SQLType {
		if (this.onQuery) {
			const onSql = is(this.onQuery, SQL) ? this.onQuery : this.onQuery.getSQL()
			return this.dialect.buildUpdateQuery({
				table: this.table,
				on: onSql,
				withList: this.withList,
				returning: this.returningFields,
			})
		}

		if (!this.valuesData) {
			throw new Error('Update values are missing')
		}

		validateTableColumnKeys(this.table, this.valuesData, 'update')

		const columns = getTableColumns(this.table)
		const setEntries = Object.entries(columns).flatMap(([key, column]) => {
			const value = resolveUpdateValue(column, this.valuesData?.[key])
			if (value === undefined) {
				return []
			}

			return [yql`${yql.identifier(column.name)} = ${value}`]
		})

		if (setEntries.length === 0) {
			throw new Error('Update values are empty')
		}

		return this.dialect.buildUpdateQuery({
			table: this.table,
			set: this.valuesData,
			where: this.whereClause,
			withList: this.withList,
			returning: this.returningFields,
		})
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

export class YdbBatchUpdateBuilder<TResult = unknown> extends QueryPromise<TResult> {
	private valuesData: UpdateValues | undefined
	private whereClause: SQLType | undefined

	constructor(
		private readonly table: YdbTable,
		private readonly session: YdbSession,
		private readonly dialect = new YdbDialect()
	) {
		super()
	}

	set(values: UpdateValues): this {
		this.valuesData = values
		return this
	}

	where(where: SQLType | undefined): this {
		this.whereClause = where ?? undefined
		return this
	}

	returning(): never {
		throw new Error('YDB batchUpdate().returning() is not supported')
	}

	on(): never {
		throw new Error('YDB batchUpdate().on() is not supported')
	}

	getSQL(): SQLType {
		if (!this.valuesData) {
			throw new Error('Update values are missing')
		}

		validateTableColumnKeys(this.table, this.valuesData, 'update')

		return this.dialect.buildUpdateQuery({
			table: this.table,
			set: this.valuesData,
			where: this.whereClause,
			batch: true,
		})
	}

	toSQL() {
		const { typings: _typings, ...query } = this.dialect.sqlToQuery(this.getSQL())
		return query
	}

	prepare(name?: string) {
		return this.session.prepareQuery<YdbPreparedQueryConfig & { execute: TResult }>(
			this.getSQL(),
			undefined,
			name,
			false
		)
	}

	override execute(): Promise<TResult> {
		return this.prepare().execute() as Promise<TResult>
	}
}
