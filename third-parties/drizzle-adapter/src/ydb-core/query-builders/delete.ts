import { is } from 'drizzle-orm/entity'
import { QueryPromise } from 'drizzle-orm/query-promise'
import { SQL, type SQL as SQLType, type SQLWrapper } from 'drizzle-orm/sql/sql'
import type { Subquery } from 'drizzle-orm/subquery'
import { Table } from 'drizzle-orm/table'
import type { YdbPreparedQueryConfig, YdbSession } from '../session.js'
import type { YdbTable } from '../table.js'
import { type YdbSelectedFieldsOrdered, orderSelectedFields } from '../result-mapping.js'
import { YdbDialect } from '../../ydb/dialect.js'
import { validateSetBasedMutationSelection } from './utils.js'
import { YdbQueryBuilder } from './query-builder.js'

type DeleteOnQuery =
	| SQLType
	| {
			getSQL(): SQLType
			getSelectedFields(): Record<string, unknown> | undefined
	  }

function getAllReturningFields(table: YdbTable): Record<string, unknown> {
	return (table as any)[(Table as any).Symbol.Columns] ?? {}
}

export class YdbDeleteBuilder<TResult = unknown> extends QueryPromise<TResult> {
	#whereClause: SQLType | undefined
	#usingTables: SQLWrapper[] = []
	#onQuery: DeleteOnQuery | undefined
	#returningFields: YdbSelectedFieldsOrdered | undefined

	readonly #table: YdbTable
	readonly #session: YdbSession
	readonly #dialect: YdbDialect
	readonly #withList: Subquery[]

	constructor(
		table: YdbTable,
		session: YdbSession,
		dialect = new YdbDialect(),
		withList: Subquery[] = []
	) {
		super()
		this.#table = table
		this.#session = session
		this.#dialect = dialect
		this.#withList = withList
	}

	where(where: SQLType | undefined): this {
		if (this.#onQuery) {
			throw new Error('YDB delete().on() does not support where()')
		}

		this.#whereClause = where ?? undefined
		return this
	}

	using(...tables: SQLWrapper[]): this {
		if (this.#onQuery) {
			throw new Error('YDB delete().on() does not support using()')
		}

		this.#usingTables = [...tables]
		return this
	}

	on(query: DeleteOnQuery | ((qb: YdbQueryBuilder) => DeleteOnQuery)): this {
		let resolved =
			typeof query === 'function' ? query(new YdbQueryBuilder(this.#dialect)) : query

		if (!is(resolved, SQL)) {
			validateSetBasedMutationSelection(this.#table, resolved.getSelectedFields(), 'delete')
		}

		this.#onQuery = resolved
		this.#whereClause = undefined
		this.#usingTables = []
		return this
	}

	returning(fields: Record<string, unknown> = getAllReturningFields(this.#table)): this {
		let orderedFields = orderSelectedFields(fields)
		if (orderedFields.length === 0) {
			throw new Error('YDB returning() requires at least one field')
		}

		this.#returningFields = orderedFields
		return this
	}

	getSQL(): SQLType {
		if (this.#onQuery) {
			let onSql = is(this.#onQuery, SQL) ? this.#onQuery : this.#onQuery.getSQL()

			return this.#dialect.buildDeleteQuery({
				table: this.#table,
				on: onSql,
				withList: this.#withList,
				returning: this.#returningFields,
			})
		}

		return this.#dialect.buildDeleteQuery({
			table: this.#table,
			where: this.#whereClause,
			using: this.#usingTables.length > 0 ? [...this.#usingTables] : undefined,
			withList: this.#withList,
			returning: this.#returningFields,
		})
	}

	toSQL() {
		let { typings: _typings, ...query } = this.#dialect.sqlToQuery(this.getSQL())
		return query
	}

	prepare(name?: string) {
		return this.#session.prepareQuery<YdbPreparedQueryConfig & { execute: TResult }>(
			this.getSQL(),
			this.#returningFields,
			name,
			this.#returningFields !== undefined
		)
	}

	override execute(): Promise<TResult> {
		return this.prepare().execute() as Promise<TResult>
	}
}

export class YdbBatchDeleteBuilder<TResult = unknown> extends QueryPromise<TResult> {
	#whereClause: SQLType | undefined

	readonly #table: YdbTable
	readonly #session: YdbSession
	readonly #dialect: YdbDialect

	constructor(table: YdbTable, session: YdbSession, dialect = new YdbDialect()) {
		super()
		this.#table = table
		this.#session = session
		this.#dialect = dialect
	}

	where(where: SQLType | undefined): this {
		this.#whereClause = where ?? undefined
		return this
	}

	using(): never {
		throw new Error('YDB batchDelete().using() is not supported')
	}

	on(): never {
		throw new Error('YDB batchDelete().on() is not supported')
	}

	returning(): never {
		throw new Error('YDB batchDelete().returning() is not supported')
	}

	getSQL(): SQLType {
		return this.#dialect.buildDeleteQuery({
			table: this.#table,
			where: this.#whereClause,
			batch: true,
		})
	}

	toSQL() {
		let { typings: _typings, ...query } = this.#dialect.sqlToQuery(this.getSQL())
		return query
	}

	prepare(name?: string) {
		return this.#session.prepareQuery<YdbPreparedQueryConfig & { execute: TResult }>(
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
