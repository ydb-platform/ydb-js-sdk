import { entityKind } from 'drizzle-orm/entity'
import type { RelationalSchemaConfig, TablesRelationalConfig } from 'drizzle-orm/relations'
import { type SQL, type SQLWrapper } from 'drizzle-orm/sql/sql'
import type { WithSubquery } from 'drizzle-orm/subquery'
import type { DrizzleTypeError } from 'drizzle-orm/utils'
import type { YdbTransactionConfig } from '../ydb/driver.js'
import type { YdbDialect } from '../ydb/dialect.js'
import type { YdbSession } from './session.js'
import type { YdbQuerySource } from './session.js'
import type {
	YdbSchemaDefinition,
	YdbSchemaRelations,
	YdbSchemaWithoutTables,
} from './schema.types.js'
import type { YdbTable } from './table.js'
import {
	YdbBatchDeleteBuilder,
	YdbBatchUpdateBuilder,
	YdbCountBuilder,
	YdbDeleteBuilder,
	YdbInsertBuilder,
	YdbQueryBuilder,
	YdbRelationalQueryBuilder,
	YdbReplaceBuilder,
	YdbSelectBuilder,
	YdbUpdateBuilder,
	YdbUpsertBuilder,
} from './query-builders/index.js'

export type YdbTransactionScope<
	TSchemaDefinition extends YdbSchemaDefinition = YdbSchemaWithoutTables,
	TSchemaRelations extends TablesRelationalConfig = YdbSchemaRelations<TSchemaDefinition>,
> = Omit<YdbDatabase<TSchemaDefinition, TSchemaRelations>, 'transaction'> & {
	rollback(): never
}

export class YdbDatabase<
	TSchemaDefinition extends YdbSchemaDefinition = YdbSchemaWithoutTables,
	TSchemaRelations extends TablesRelationalConfig = YdbSchemaRelations<TSchemaDefinition>,
> {
	static readonly [entityKind] = 'YdbDatabase'

	readonly _: {
		readonly schema: TSchemaRelations | undefined
		readonly fullSchema: TSchemaDefinition
		readonly tableNamesMap: Record<string, string>
		readonly session: YdbSession
	}

	query: TSchemaDefinition extends YdbSchemaWithoutTables
		? DrizzleTypeError<'Seems like the schema generic is missing - did you forget to add it to your DB type?'>
		: {
				[K in keyof TSchemaRelations]: YdbRelationalQueryBuilder<
					TSchemaRelations,
					TSchemaRelations[K]
				>
			}

	constructor(
		protected readonly dialect: YdbDialect,
		protected readonly session: YdbSession,
		schema?: RelationalSchemaConfig<TSchemaRelations>
	) {
		this._ = schema
			? {
					schema: schema.schema,
					fullSchema: schema.fullSchema as TSchemaDefinition,
					tableNamesMap: schema.tableNamesMap,
					session,
				}
			: {
					schema: undefined,
					fullSchema: {} as TSchemaDefinition,
					tableNamesMap: {},
					session,
				}

		const queryBuilders = new Map<string, YdbRelationalQueryBuilder<TSchemaRelations, any>>()
		const getRelationalTableConfig = (tableKey: string) => {
			const schemaByKey = this._.schema as
				| Record<string, TSchemaRelations[keyof TSchemaRelations]>
				| undefined
			return schemaByKey?.[tableKey]
		}
		const getRelationalQueryBuilder = (tableKey: string) => {
			const tableConfig = getRelationalTableConfig(tableKey)

			if (!tableConfig) {
				return undefined
			}

			const cached = queryBuilders.get(tableKey)
			if (cached) {
				return cached
			}

			const table = (this._.fullSchema as Record<string, unknown>)[tableConfig.tsName] as
				| YdbTable
				| undefined

			if (!table) {
				throw new Error(`Table ${tableConfig.tsName} not found in schema`)
			}

			const builder = new YdbRelationalQueryBuilder(
				this._.fullSchema,
				this._.schema!,
				this._.tableNamesMap,
				table,
				tableConfig,
				this.dialect,
				this.session
			)
			queryBuilders.set(tableKey, builder)

			return builder
		}

		if (this._.schema) {
			this.query = new Proxy(Object.create(null), {
				get: (_target, property) => {
					if (typeof property !== 'string') {
						return undefined
					}

					return getRelationalQueryBuilder(property)
				},
				getOwnPropertyDescriptor: (_target, property) => {
					if (typeof property !== 'string' || !getRelationalTableConfig(property)) {
						return undefined
					}

					return {
						configurable: true,
						enumerable: true,
						get: () => getRelationalQueryBuilder(property),
					}
				},
				has: (_target, property) => {
					return typeof property === 'string' && !!getRelationalTableConfig(property)
				},
				ownKeys: () => Object.keys(this._.schema!),
			}) as typeof this.query
		} else {
			this.query = Object.create(null) as typeof this.query
		}
	}

	execute<T = unknown>(query: YdbQuerySource): Promise<T> {
		return this.session.execute<T>(query)
	}

	all<T = unknown>(query: YdbQuerySource): Promise<T[]> {
		return this.session.all<T>(query)
	}

	get<T = unknown>(query: YdbQuerySource): Promise<T> {
		return this.session.get<T>(query)
	}

	values<T extends unknown[] = unknown[]>(query: YdbQuerySource): Promise<T[]> {
		return this.session.values<T>(query)
	}

	$with<TAlias extends string>(alias: TAlias) {
		return new YdbQueryBuilder(this.dialect).$with(alias)
	}

	with(...queries: WithSubquery[]) {
		const { session, dialect } = this

		function select<TFields extends Record<string, unknown> | undefined = undefined>(
			fields?: TFields
		) {
			return new YdbSelectBuilder(session, dialect, fields as any, {}, queries)
		}

		function selectDistinct<TFields extends Record<string, unknown> | undefined = undefined>(
			fields?: TFields
		) {
			return new YdbSelectBuilder(
				session,
				dialect,
				fields as any,
				{ distinct: true },
				queries
			)
		}

		function selectDistinctOn<TFields extends Record<string, unknown> | undefined = undefined>(
			on: SQLWrapper | SQLWrapper[],
			fields?: TFields
		) {
			return new YdbSelectBuilder(
				session,
				dialect,
				fields as any,
				{
					distinctOn: Array.isArray(on) ? on : [on],
				},
				queries
			)
		}

		function insert(table: YdbTable) {
			return new YdbInsertBuilder(table, session, dialect, queries)
		}

		function upsert(table: YdbTable) {
			return new YdbUpsertBuilder(table, session, dialect, queries)
		}

		function replace(table: YdbTable) {
			return new YdbReplaceBuilder(table, session, dialect, queries)
		}

		function update(table: YdbTable) {
			return new YdbUpdateBuilder(table, session, dialect, queries)
		}

		function delete_(table: YdbTable) {
			return new YdbDeleteBuilder(table, session, dialect, queries)
		}

		return {
			select,
			selectDistinct,
			selectDistinctOn,
			insert,
			upsert,
			replace,
			update,
			delete: delete_,
		}
	}

	$count(source: YdbTable | SQLWrapper, filters?: SQL) {
		return new YdbCountBuilder({ source, filters, session: this.session })
	}

	select<TFields extends Record<string, unknown> | undefined = undefined>(fields?: TFields) {
		return new YdbSelectBuilder(this.session, this.dialect, fields as any)
	}

	selectDistinct<TFields extends Record<string, unknown> | undefined = undefined>(
		fields?: TFields
	) {
		return new YdbSelectBuilder(this.session, this.dialect, fields as any, { distinct: true })
	}

	selectDistinctOn<TFields extends Record<string, unknown> | undefined = undefined>(
		on: SQLWrapper | SQLWrapper[],
		fields?: TFields
	) {
		return new YdbSelectBuilder(this.session, this.dialect, fields as any, {
			distinctOn: Array.isArray(on) ? on : [on],
		})
	}

	insert(table: YdbTable) {
		return new YdbInsertBuilder(table, this.session, this.dialect)
	}

	upsert(table: YdbTable) {
		return new YdbUpsertBuilder(table, this.session, this.dialect)
	}

	replace(table: YdbTable) {
		return new YdbReplaceBuilder(table, this.session, this.dialect)
	}

	update(table: YdbTable) {
		return new YdbUpdateBuilder(table, this.session, this.dialect)
	}

	batchUpdate(table: YdbTable) {
		return new YdbBatchUpdateBuilder(table, this.session, this.dialect)
	}

	delete(table: YdbTable) {
		return new YdbDeleteBuilder(table, this.session, this.dialect)
	}

	batchDelete(table: YdbTable) {
		return new YdbBatchDeleteBuilder(table, this.session, this.dialect)
	}

	transaction<T>(
		transaction: (tx: YdbTransactionScope<TSchemaDefinition, TSchemaRelations>) => Promise<T>,
		config?: YdbTransactionConfig
	) {
		const schema = this._.schema
			? ({
					fullSchema: this._.fullSchema,
					schema: this._.schema,
					tableNamesMap: this._.tableNamesMap,
				} as RelationalSchemaConfig<TSchemaRelations>)
			: undefined

		return this.session.transaction(transaction, config, schema)
	}
}
