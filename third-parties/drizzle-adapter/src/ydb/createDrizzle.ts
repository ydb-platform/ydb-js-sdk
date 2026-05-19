import { DefaultLogger, type Logger } from 'drizzle-orm/logger'
import { createTableRelationsHelpers, extractTablesRelationalConfig } from 'drizzle-orm/relations'
import type { Casing } from 'drizzle-orm/utils'
import { YdbDialect } from './dialect.js'
import {
	YdbDriver,
	type YdbExecutor,
	type YdbRemoteCallback,
	type YdbTransactionalExecutor,
} from './driver.js'
import type {
	YdbSchemaDefinition,
	YdbSchemaRelations,
	YdbSchemaWithoutTables,
} from '../ydb-core/schema.types.js'
import { YdbSession } from '../ydb-core/session.js'
import { YdbDatabase } from '../ydb-core/db.js'

export interface YdbDrizzleConfig<
	TSchemaDefinition extends YdbSchemaDefinition = YdbSchemaWithoutTables,
> {
	casing?: Casing | undefined
	logger?: boolean | Logger | undefined
	/** Exact schema object that powers typed queries like `db.query.users.findMany()`. */
	schema?: TSchemaDefinition | undefined
}

export interface YdbDrizzleOptions<
	TSchemaDefinition extends YdbSchemaDefinition = YdbSchemaWithoutTables,
> extends YdbDrizzleConfig<TSchemaDefinition> {
	connectionString?: string | undefined
	client?: YdbExecutor | YdbTransactionalExecutor | undefined
}

export type YdbDrizzleDatabase<
	TSchemaDefinition extends YdbSchemaDefinition = YdbSchemaWithoutTables,
> = YdbDatabase<TSchemaDefinition, YdbSchemaRelations<TSchemaDefinition>> & { $client: YdbExecutor }

function isYdbExecutor(value: unknown): value is YdbExecutor {
	return (
		!!value && typeof value === 'object' && typeof (value as YdbExecutor).execute === 'function'
	)
}

function makeDb<TSchemaDefinition extends YdbSchemaDefinition>(
	executor: YdbExecutor | YdbTransactionalExecutor,
	config: YdbDrizzleConfig<TSchemaDefinition> = {}
): YdbDrizzleDatabase<TSchemaDefinition> {
	const dialect = new YdbDialect(config.casing === undefined ? {} : { casing: config.casing })

	let logger: Logger | undefined = undefined
	if (config.logger === true) {
		logger = new DefaultLogger()
	} else if (config.logger !== false) {
		logger = config.logger
	}

	const schema = config.schema
		? (() => {
				const tablesConfig = extractTablesRelationalConfig(
					config.schema,
					createTableRelationsHelpers
				)

				return {
					fullSchema: config.schema,
					schema: tablesConfig.tables as YdbSchemaRelations<TSchemaDefinition>,
					tableNamesMap: tablesConfig.tableNamesMap,
				}
			})()
		: undefined

	const session = new YdbSession(executor, dialect, logger === undefined ? {} : { logger })
	const db = new YdbDatabase<TSchemaDefinition>(
		dialect,
		session,
		schema
	) as YdbDrizzleDatabase<TSchemaDefinition>
	db.$client = executor
	return db
}

function isYdbOptions<TSchemaDefinition extends YdbSchemaDefinition>(
	value: unknown
): value is YdbDrizzleOptions<TSchemaDefinition> {
	if (!value || typeof value !== 'object') {
		return false
	}

	if (isYdbExecutor(value)) {
		return false
	}

	return 'connectionString' in value || 'client' in value || 'schema' in value
}

export function createDrizzle<TSchemaDefinition extends YdbSchemaDefinition>(
	input: YdbExecutor | YdbTransactionalExecutor | YdbRemoteCallback,
	config: YdbDrizzleConfig<TSchemaDefinition> & { schema: TSchemaDefinition }
): YdbDrizzleDatabase<TSchemaDefinition>
export function createDrizzle(
	input: YdbExecutor | YdbTransactionalExecutor | YdbRemoteCallback,
	config?: YdbDrizzleConfig<YdbSchemaWithoutTables>
): YdbDrizzleDatabase<YdbSchemaWithoutTables>
export function createDrizzle<TSchemaDefinition extends YdbSchemaDefinition>(
	input: YdbDrizzleOptions<TSchemaDefinition> & { schema: TSchemaDefinition }
): YdbDrizzleDatabase<TSchemaDefinition>
export function createDrizzle(
	input: YdbDrizzleOptions<YdbSchemaWithoutTables>
): YdbDrizzleDatabase<YdbSchemaWithoutTables>
export function createDrizzle<
	TSchemaDefinition extends YdbSchemaDefinition = YdbSchemaWithoutTables,
>(
	input:
		| YdbExecutor
		| YdbTransactionalExecutor
		| YdbRemoteCallback
		| YdbDrizzleOptions<TSchemaDefinition>,
	config?: YdbDrizzleConfig<TSchemaDefinition>
): YdbDrizzleDatabase<TSchemaDefinition> {
	if (typeof input === 'function') {
		return makeDb(YdbDriver.fromCallback(input), config)
	}

	if (isYdbExecutor(input)) {
		return makeDb(input, config)
	}

	if (isYdbOptions<TSchemaDefinition>(input)) {
		if (input.client) {
			return makeDb(input.client, input)
		}
		if (input.connectionString) {
			const client = new YdbDriver(input.connectionString)
			return makeDb(client, input)
		}
		throw new Error('Must include either `client` or `connectionString`.')
	}

	return makeDb(input, config)
}

export const drizzle = createDrizzle
