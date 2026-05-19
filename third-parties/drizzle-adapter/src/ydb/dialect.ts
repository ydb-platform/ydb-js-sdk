// eslint-disable no-await-in-loop
import * as crypto from 'node:crypto'
import {
	aliasedTable,
	aliasedTableColumn,
	mapColumnsInAliasedSQLToAlias,
	mapColumnsInSQLToAlias,
} from 'drizzle-orm/alias'
import { CasingCache } from 'drizzle-orm/casing'
import { Column } from 'drizzle-orm/column'
import { entityKind, is } from 'drizzle-orm/entity'
import { DrizzleError } from 'drizzle-orm/errors'
import { getOperators, getOrderByOperators } from 'drizzle-orm/relations'
import {
	type DriverValueEncoder,
	type QueryTypingsValue,
	type QueryWithTypings,
	SQL,
	sql as yql,
} from 'drizzle-orm/sql/sql'
import { and } from 'drizzle-orm/sql/expressions'
import type { Casing } from 'drizzle-orm/utils'
import type { YdbSession } from '../ydb-core/session.js'
import type { YdbSelectedFieldsOrdered } from '../ydb-core/result-mapping.js'
import type { YdbColumn } from '../ydb-core/columns/common.js'
import {
	type YdbMigrationStatus,
	buildMigrationHistoryInsertSql,
	buildMigrationHistoryMetadataColumnSql,
	buildMigrationHistoryMetadataProbeSql,
	buildMigrationHistorySelectSql,
	buildMigrationLockRefreshSql,
	buildMigrationLockReleaseSql,
	buildMigrationLockSelectSql,
	buildMigrationLockTableBootstrapSql,
	buildMigrationLockUpsertSql,
	buildMigrationTableBootstrapSql,
	buildStableMigrationName,
} from './migration-ddl.js'
import {
	buildFromTable,
	buildJoins,
	buildLimit,
	buildOffset,
	buildOrderBy,
	buildReturningSelection,
	buildSelectQuery,
	buildSelection,
	buildSetOperationQuery,
	buildSetOperations,
	getSelectionAliases,
	mapExpressionsToSelectionAliases,
} from './dialect.select.js'
import type {
	YdbDeleteConfig,
	YdbDialectMigration,
	YdbDialectMigrationConfig,
	YdbInsertConfig,
	YdbJoinConfig,
	YdbRelationalQueryConfig,
	YdbRelationalQueryResult,
	YdbSelectConfig,
	YdbSetOperatorConfig,
	YdbUpdateConfig,
} from './dialect.types.js'
import {
	getInsertColumnEntries,
	getPrimaryColumnKeys,
	getTableColumns,
	resolveInsertValue,
	resolveUpdateValue,
	validateTableColumnKeys,
} from '../ydb-core/query-builders/utils.js'

export interface YdbDialectConfig {
	casing?: Casing | undefined
}

export {
	type YdbDeleteConfig,
	type YdbDialectMigration,
	type YdbDialectMigrationConfig,
	type YdbFlatRelationalQueryConfig,
	type YdbInsertConfig,
	type YdbJoinConfig,
	type YdbJoinType,
	type YdbRelationalQueryConfig,
	type YdbRelationalQueryResult,
	type YdbSelectConfig,
	type YdbSetOperatorConfig,
	type YdbSetOperatorSource,
	type YdbUpdateConfig,
} from './dialect.types.js'

function isNumberValue(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value)
}

function deriveMigrationName(migration: YdbDialectMigration): string {
	return buildStableMigrationName(migration)
}

type MigrationSession = Pick<YdbSession, 'execute' | 'values'>

type MigrationTransactionalSession = MigrationSession & {
	transaction<T>(
		callback: (tx: MigrationSession) => Promise<T>,
		config?: { accessMode?: 'read only' | 'read write'; idempotent?: boolean }
	): Promise<T>
}

type MigrationSessionInput = MigrationSession & {
	transaction?: MigrationTransactionalSession['transaction']
}

interface NormalizedMigrationHistoryRow {
	hash: string
	folderMillis: number
	name: string
	status: YdbMigrationStatus
	startedAt?: number | undefined
	finishedAt?: number | undefined
	error?: string | undefined
	ownerId?: string | undefined
	statementsTotal?: number | undefined
	statementsApplied?: number | undefined
}

interface NormalizedMigrationLockConfig {
	key: string
	ownerId: string
	leaseMs: number
	acquireTimeoutMs: number
	retryIntervalMs: number
}

interface MigrationLockHandle {
	ownerId: string
	assertHealthy(): void
	release(): Promise<void>
}

const defaultMigrationLockLeaseMs = 10 * 60 * 1000
const defaultMigrationLockAcquireTimeoutMs = 60 * 1000
const defaultMigrationLockRetryIntervalMs = 1000
const defaultMigrationStaleRunningAfterMs = 60 * 60 * 1000

function isMigrationTransactionalSession(
	session: MigrationSession
): session is MigrationTransactionalSession {
	return (
		'transaction' in session &&
		typeof (session as MigrationTransactionalSession).transaction === 'function'
	)
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function isMissingMigrationMetadataError(error: unknown): boolean {
	return /column|member|unknown|not found|does not exist|no such|type annotation/i.test(
		getErrorMessage(error)
	)
}

function isAlreadyExistsError(error: unknown): boolean {
	return /already|exists|duplicate/i.test(getErrorMessage(error))
}

function toOptionalNumber(value: unknown): number | undefined {
	if (value === undefined || value === null) {
		return undefined
	}

	const numberValue = typeof value === 'bigint' ? Number(value) : Number(value)
	return Number.isFinite(numberValue) ? numberValue : undefined
}

function normalizeMigrationHistoryRow(row: unknown[]): NormalizedMigrationHistoryRow {
	const status =
		row[3] === 'running' || row[3] === 'failed' || row[3] === 'applied' ? row[3] : 'applied'

	return {
		hash: String(row[0]),
		folderMillis: Number(row[1]),
		name: String(row[2]),
		status,
		startedAt: toOptionalNumber(row[4]),
		finishedAt: toOptionalNumber(row[5]),
		error: row[6] === undefined || row[6] === null ? undefined : String(row[6]),
		ownerId: row[7] === undefined || row[7] === null ? undefined : String(row[7]),
		statementsTotal: toOptionalNumber(row[8]),
		statementsApplied: toOptionalNumber(row[9]),
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function normalizeMigrationLockConfig(
	config: YdbDialectMigrationConfig
): NormalizedMigrationLockConfig {
	const lockConfig = typeof config.migrationLock === 'object' ? config.migrationLock : {}

	return {
		key: lockConfig.key ?? 'migrate',
		ownerId: lockConfig.ownerId ?? `ydb-drizzle-${process.pid}-${crypto.randomUUID()}`,
		leaseMs: normalizePositiveNumber(lockConfig.leaseMs, defaultMigrationLockLeaseMs),
		acquireTimeoutMs: normalizePositiveNumber(
			lockConfig.acquireTimeoutMs,
			defaultMigrationLockAcquireTimeoutMs
		),
		retryIntervalMs: normalizePositiveNumber(
			lockConfig.retryIntervalMs,
			defaultMigrationLockRetryIntervalMs
		),
	}
}

function shouldRetryMigration(
	row: NormalizedMigrationHistoryRow,
	now: number,
	config: YdbDialectMigrationConfig
): boolean {
	const recovery = config.migrationRecovery ?? {}
	const mode = recovery.mode ?? 'fail'
	if (mode !== 'retry') {
		return false
	}

	if (row.status === 'failed') {
		return true
	}

	const staleAfterMs = normalizePositiveNumber(
		recovery.staleRunningAfterMs,
		defaultMigrationStaleRunningAfterMs
	)
	return (
		row.status === 'running' &&
		row.startedAt !== undefined &&
		now - row.startedAt > staleAfterMs
	)
}

function assertMigrationRecoverable(
	row: NormalizedMigrationHistoryRow,
	now: number,
	config: YdbDialectMigrationConfig
): void {
	if (row.status === 'applied') {
		return
	}

	if (shouldRetryMigration(row, now, config)) {
		return
	}

	if (row.status === 'failed') {
		throw new Error(
			`YDB migration "${row.name}" (${row.hash}) is marked as failed after ${row.statementsApplied ?? 0}/${row.statementsTotal ?? 0} statements. ` +
				'Fix the migration manually or rerun with migrationRecovery.mode = "retry".'
		)
	}

	const staleAfterMs = normalizePositiveNumber(
		config.migrationRecovery?.staleRunningAfterMs,
		defaultMigrationStaleRunningAfterMs
	)
	const age = row.startedAt === undefined ? 'unknown' : `${now - row.startedAt}ms`
	throw new Error(
		`YDB migration "${row.name}" (${row.hash}) is still marked as running (age: ${age}, owner: ${row.ownerId ?? 'unknown'}). ` +
			`It is treated as active until it is older than ${staleAfterMs}ms; use migrationRecovery.mode = "retry" only after verifying the previous run is dead.`
	)
}

function yqlBindingName(alias: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(alias)) {
		throw new Error(`YDB CTE alias "${alias}" cannot be used as a YQL binding name`)
	}

	return `$${alias}`
}

async function ensureMigrationHistoryTable(
	session: MigrationSession,
	config: YdbDialectMigrationConfig
): Promise<void> {
	await session.execute(yql.raw(buildMigrationTableBootstrapSql(config)))

	try {
		await session.values(yql.raw(buildMigrationHistoryMetadataProbeSql(config)))
		return
	} catch (error) {
		if (!isMissingMigrationMetadataError(error)) {
			throw error
		}
	}

	for (const statement of buildMigrationHistoryMetadataColumnSql(config)) {
		try {
			await session.execute(yql.raw(statement))
		} catch (error) {
			if (!isAlreadyExistsError(error)) {
				throw error
			}
		}
	}
}

async function acquireMigrationLock(
	session: MigrationSession,
	config: YdbDialectMigrationConfig
): Promise<MigrationLockHandle> {
	if (!isMigrationTransactionalSession(session)) {
		throw new Error(
			'YDB migrate() migrationLock requires a transactional YDB session. Pass migrationLock: false to opt out.'
		)
	}

	const lockConfig = normalizeMigrationLockConfig(config)
	const deadline = Date.now() + lockConfig.acquireTimeoutMs
	let lastError: unknown

	while (Date.now() <= deadline) {
		const now = Date.now()

		try {
			const acquired = await session.transaction(
				async (tx) => {
					const rows = await tx.values<[string, number | string]>(
						yql.raw(buildMigrationLockSelectSql(config, lockConfig.key))
					)
					const [ownerId, expiresAtRaw] = rows[0] ?? []
					const expiresAt = Number(expiresAtRaw ?? 0)

					if (ownerId && ownerId !== lockConfig.ownerId && expiresAt > now) {
						return false
					}

					await tx.execute(
						yql.raw(
							buildMigrationLockUpsertSql(config, {
								key: lockConfig.key,
								ownerId: lockConfig.ownerId,
								acquiredAt: now,
								heartbeatAt: now,
								expiresAt: now + lockConfig.leaseMs,
							})
						)
					)

					return true
				},
				{ accessMode: 'read write', idempotent: false }
			)

			if (acquired) {
				let heartbeatError: unknown
				let heartbeatInFlight = false
				const heartbeatEveryMs = Math.max(1000, Math.floor(lockConfig.leaseMs / 3))
				const heartbeat = setInterval(() => {
					if (heartbeatInFlight) {
						return
					}

					heartbeatInFlight = true
					const heartbeatAt = Date.now()
					void session
						.execute(
							yql.raw(
								buildMigrationLockRefreshSql(config, {
									key: lockConfig.key,
									ownerId: lockConfig.ownerId,
									heartbeatAt,
									expiresAt: heartbeatAt + lockConfig.leaseMs,
								})
							)
						)
						.catch((error) => {
							heartbeatError = error
						})
						.finally(() => {
							heartbeatInFlight = false
						})
				}, heartbeatEveryMs)
				heartbeat.unref?.()

				return {
					ownerId: lockConfig.ownerId,
					assertHealthy() {
						if (heartbeatError) {
							throw new Error(
								`YDB migrate() lock heartbeat failed: ${getErrorMessage(heartbeatError)}`,
								{ cause: heartbeatError }
							)
						}
					},
					async release() {
						clearInterval(heartbeat)
						await session.execute(
							yql.raw(
								buildMigrationLockReleaseSql(config, {
									key: lockConfig.key,
									ownerId: lockConfig.ownerId,
								})
							)
						)
					},
				}
			}
		} catch (error) {
			lastError = error
		}

		const remainingMs = deadline - Date.now()
		if (remainingMs <= 0) {
			break
		}

		await sleep(Math.min(lockConfig.retryIntervalMs, remainingMs))
	}

	throw new Error(
		`YDB migrate() could not acquire migration lock "${lockConfig.key}" within ${lockConfig.acquireTimeoutMs}ms.`,
		{ cause: lastError }
	)
}

export class YdbDialect {
	static readonly [entityKind] = 'YdbDialect'
	private readonly casing: CasingCache

	constructor(config: YdbDialectConfig = {}) {
		this.casing = new CasingCache(config.casing)
	}

	escapeName(name: string): string {
		return `\`${name.replace(/`/g, '``')}\``
	}

	escapeParam(num: number): string {
		return `$p${num}`
	}

	escapeString(str: string): string {
		return `'${str.replace(/'/g, "''")}'`
	}

	prepareTyping(encoder?: DriverValueEncoder<unknown, unknown>): QueryTypingsValue {
		const sqlType =
			typeof (encoder as unknown as { getSQLType?: () => string } | undefined)?.getSQLType ===
			'function'
				? (encoder as unknown as { getSQLType(): string }).getSQLType()
				: undefined

		if (sqlType === 'Json' || sqlType === 'JsonDocument') {
			return 'json'
		}

		if (sqlType?.startsWith('Decimal(')) {
			return 'decimal'
		}

		if (sqlType === 'Date' || sqlType === 'Date32') {
			return 'date'
		}

		if (
			sqlType === 'Datetime' ||
			sqlType === 'Timestamp' ||
			sqlType === 'Datetime64' ||
			sqlType === 'Timestamp64'
		) {
			return 'timestamp'
		}

		if (sqlType === 'Uuid') {
			return 'uuid'
		}

		return 'none'
	}

	buildWithCTE(queries: { _: { alias: string; sql: SQL } }[] | undefined): SQL | undefined {
		if (!queries || queries.length === 0) {
			return undefined
		}

		const withSqlChunks: SQL[] = []
		for (const query of queries) {
			withSqlChunks.push(yql`${yql.raw(yqlBindingName(query._.alias))} = (${query._.sql}); `)
		}

		return yql.join(withSqlChunks)
	}

	getSelectionAliases(fields: YdbSelectedFieldsOrdered): string[] {
		return getSelectionAliases(fields)
	}

	mapExpressionsToSelectionAliases(
		expressions: Parameters<typeof mapExpressionsToSelectionAliases>[0],
		fields: Parameters<typeof mapExpressionsToSelectionAliases>[1],
		selectionAliases: Parameters<typeof mapExpressionsToSelectionAliases>[2],
		context: Parameters<typeof mapExpressionsToSelectionAliases>[3]
	) {
		return mapExpressionsToSelectionAliases(expressions, fields, selectionAliases, context)
	}

	buildSelection(fields: YdbSelectedFieldsOrdered, aliases?: string[]) {
		return buildSelection(fields, aliases)
	}

	buildReturningSelection(fields: YdbSelectedFieldsOrdered) {
		return buildReturningSelection(fields)
	}

	buildFromTable(table: unknown) {
		return buildFromTable(table)
	}

	buildJoins(joins: YdbJoinConfig[] | undefined) {
		return buildJoins(joins)
	}

	buildOrderBy(orderBy: Parameters<typeof buildOrderBy>[0]) {
		return buildOrderBy(orderBy)
	}

	buildLimit(limit: number | undefined) {
		return buildLimit(limit)
	}

	buildOffset(offset: number | undefined) {
		return buildOffset(offset)
	}

	buildSetOperationQuery(
		leftSelect: SQL,
		fields: YdbSelectedFieldsOrdered,
		selectionAliases: string[],
		setOperator: YdbSetOperatorConfig
	) {
		return buildSetOperationQuery(leftSelect, fields, selectionAliases, setOperator)
	}

	buildSetOperations(
		leftSelect: SQL,
		fields: YdbSelectedFieldsOrdered,
		selectionAliases: string[],
		setOperators: YdbSetOperatorConfig[]
	) {
		return buildSetOperations(leftSelect, fields, selectionAliases, setOperators)
	}

	buildSelectQuery(config: YdbSelectConfig) {
		const withSql = this.buildWithCTE(config.withList)
		const query = buildSelectQuery(config)
		return withSql ? yql`${withSql}${query}` : query
	}

	buildInsertQuery(config: YdbInsertConfig): SQL {
		const withSql = this.buildWithCTE(config.withList)
		const columnEntries = config.columnEntries ?? getInsertColumnEntries(config.table)
		if (columnEntries.length === 0) {
			throw new Error('Insertable columns are missing')
		}

		const commandName = config.command ?? 'insert'
		const commandLabel = commandName.charAt(0).toUpperCase() + commandName.slice(1)
		const insertOrder = yql`(${yql.join(
			columnEntries.map(([, column]) => yql.identifier(column.name)),
			yql`, `
		)})`
		const command = yql.raw(commandName)
		const returningSql = config.returning
			? yql` returning ${this.buildReturningSelection(config.returning)}`
			: undefined

		if (config.select) {
			const selectQuery = is(config.values, SQL)
				? config.values
				: (config.values as { getSQL(): SQL }).getSQL()
			return yql`${withSql}${command} into ${config.table} ${insertOrder} ${selectQuery}${returningSql}`
		}

		if (!Array.isArray(config.values)) {
			throw new Error(`YDB ${commandName} values must be an array when select is not used`)
		}

		if (config.values.length === 0) {
			throw new Error(`${commandLabel} values are empty`)
		}

		for (const row of config.values) {
			validateTableColumnKeys(config.table, row, commandName)
		}

		const valuesSql = config.values.map(
			(row) =>
				yql`(${yql.join(
					columnEntries.map(
						([key, column]) => yql`${resolveInsertValue(column, row[key])}`
					),
					yql`, `
				)})`
		)

		return yql`${withSql}${command} into ${config.table} ${insertOrder} values ${yql.join(valuesSql, yql`, `)}${returningSql}`
	}

	buildUpdateSet(table: YdbUpdateConfig['table'], set: NonNullable<YdbUpdateConfig['set']>): SQL {
		const columns = getTableColumns(table)
		const setEntries = Object.entries(columns).flatMap(([key, column]) => {
			const value = resolveUpdateValue(column, set[key])
			if (value === undefined) {
				return []
			}

			return [yql`${yql.identifier(column.name)} = ${value}`]
		})

		if (setEntries.length === 0) {
			throw new Error('Update values are empty')
		}

		return yql.join(setEntries, yql`, `)
	}

	buildUpdateQuery(config: YdbUpdateConfig): SQL {
		const withSql = this.buildWithCTE(config.withList)
		const returningSql = config.returning
			? yql` returning ${this.buildReturningSelection(config.returning)}`
			: undefined
		const updateKeyword = config.batch ? yql`batch update` : yql`update`

		if (config.batch && (config.on || returningSql || withSql)) {
			throw new Error('YDB BATCH UPDATE cannot use WITH, ON, or RETURNING')
		}

		if (config.on) {
			return yql`${withSql}update ${this.buildFromTable(config.table)} on ${config.on}${returningSql}`
		}

		if (!config.set) {
			throw new Error('Update values are missing')
		}

		const set = config.set
		const setSql = this.buildUpdateSet(config.table, set)
		const whereSql = config.where ? yql` where ${config.where}` : undefined

		return yql`${withSql}${updateKeyword} ${this.buildFromTable(config.table)} set ${setSql}${whereSql}${returningSql}`
	}

	buildDeleteQuery(config: YdbDeleteConfig): SQL {
		const withSql = this.buildWithCTE(config.withList)
		const returningSql = config.returning
			? yql` returning ${this.buildReturningSelection(config.returning)}`
			: undefined
		const deleteKeyword = config.batch ? yql`batch delete from` : yql`delete from`

		if (
			config.batch &&
			(config.on || returningSql || withSql || (config.using && config.using.length > 0))
		) {
			throw new Error('YDB BATCH DELETE cannot use WITH, ON, USING, or RETURNING')
		}

		if (config.on) {
			if (config.where || (config.using && config.using.length > 0)) {
				throw new Error('YDB delete().on() cannot be combined with where() or using()')
			}

			return yql`${withSql}delete from ${this.buildFromTable(config.table)} on ${config.on}${returningSql}`
		}

		if (config.using && config.using.length > 0) {
			const targetTable = config.table as Parameters<typeof getTableColumns>[0]
			const columns = getTableColumns(targetTable)
			const primaryColumns = getPrimaryColumnKeys(targetTable)
				.map((key) => columns[key])
				.filter((column): column is NonNullable<typeof column> => column !== undefined)

			if (primaryColumns.length === 0) {
				throw new Error('YDB delete().using() requires at least one primary key column')
			}

			const usingJoinsSql = yql.join(
				config.using.map((table) => yql` cross join ${this.buildFromTable(table)}`),
				yql``
			)
			const innerWhereSql = config.where ? yql` where ${config.where}` : undefined
			const keySelection = yql.join(
				primaryColumns.map((column) => yql`${column}`),
				yql`, `
			)
			const outerKey =
				primaryColumns.length === 1 ? yql`${primaryColumns[0]!}` : yql`(${keySelection})`
			const innerKey = primaryColumns.length === 1 ? yql`${primaryColumns[0]!}` : keySelection

			return yql`${withSql}delete from ${this.buildFromTable(config.table)} where ${outerKey} in (select ${innerKey} from ${this.buildFromTable(
				config.table
			)}${usingJoinsSql}${innerWhereSql})${returningSql}`
		}

		const whereSql = config.where ? yql` where ${config.where}` : undefined

		return yql`${withSql}${deleteKeyword} ${this.buildFromTable(config.table)}${whereSql}${returningSql}`
	}

	buildRelationalQueryWithoutPK({
		table,
		tableConfig,
		queryConfig: config,
		tableAlias,
		joinOn,
	}: YdbRelationalQueryConfig): YdbRelationalQueryResult {
		let where: SQL | undefined
		let orderBy: SQL[] = []
		let limit: number | undefined
		let offset: number | undefined
		let selectedColumns: string[] = []
		const selectedExtras: Array<{ tsKey: string; field: SQL.Aliased }> = []

		const aliasedColumns = Object.fromEntries(
			Object.entries(tableConfig.columns).map(([key, value]) => [
				key,
				aliasedTableColumn(value, tableAlias),
			])
		) as Record<string, Column>

		if (config === true) {
			selectedColumns = Object.keys(tableConfig.columns)
		} else {
			if (config.where) {
				const whereSql =
					typeof config.where === 'function'
						? config.where(aliasedColumns, getOperators())
						: config.where
				where = whereSql ? mapColumnsInSQLToAlias(whereSql, tableAlias) : undefined
			}

			if (config.columns) {
				let isIncludeMode = false
				for (const [field, value] of Object.entries(config.columns)) {
					if (value === undefined) {
						continue
					}

					if (field in tableConfig.columns) {
						if (!isIncludeMode && value === true) {
							isIncludeMode = true
						}
						selectedColumns.push(field)
					}
				}

				if (selectedColumns.length > 0) {
					selectedColumns = isIncludeMode
						? selectedColumns.filter((column) => config.columns?.[column] === true)
						: Object.keys(tableConfig.columns).filter(
								(column) => !selectedColumns.includes(column)
							)
				}
			} else {
				selectedColumns = Object.keys(tableConfig.columns)
			}

			if (config.extras) {
				const extras =
					typeof config.extras === 'function'
						? config.extras(aliasedColumns as Record<string, Column>, { sql: yql })
						: config.extras

				for (const [tsKey, value] of Object.entries(extras)) {
					selectedExtras.push({
						tsKey,
						field: mapColumnsInAliasedSQLToAlias(value, tableAlias) as SQL.Aliased,
					})
				}
			}

			let orderByOrig =
				typeof config.orderBy === 'function'
					? config.orderBy(aliasedColumns, getOrderByOperators())
					: (config.orderBy ?? [])
			if (!Array.isArray(orderByOrig)) {
				orderByOrig = [orderByOrig]
			}

			orderBy = orderByOrig.map((orderByValue) => {
				if (is(orderByValue, Column)) {
					return aliasedTableColumn(orderByValue, tableAlias) as unknown as SQL
				}

				return mapColumnsInSQLToAlias(orderByValue, tableAlias)
			})

			if (config.limit !== undefined) {
				if (!isNumberValue(config.limit)) {
					throw new Error('YDB relational query limit must be a finite number')
				}
				limit = config.limit
			}

			const offsetValue = 'offset' in config ? config.offset : undefined
			if (offsetValue !== undefined) {
				if (!isNumberValue(offsetValue)) {
					throw new Error('YDB relational query offset must be a finite number')
				}
				offset = offsetValue
			}
		}

		if (selectedColumns.length === 0 && selectedExtras.length === 0) {
			selectedColumns =
				tableConfig.primaryKey.length > 0
					? tableConfig.primaryKey
							.map(
								(column) =>
									Object.entries(tableConfig.columns).find(
										([, value]) => value === column
									)?.[0]
							)
							.filter((value): value is string => !!value)
					: Object.keys(tableConfig.columns).slice(0, 1)
		}

		if (selectedColumns.length === 0 && selectedExtras.length === 0) {
			throw new DrizzleError({
				message: `No fields selected for table "${tableConfig.tsName}" ("${tableAlias}")`,
			})
		}

		const selection = [
			...selectedColumns.map((field) => {
				const column = tableConfig.columns[field]!
				return {
					dbKey: column.name,
					tsKey: field,
					field: aliasedTableColumn(column, tableAlias) as unknown as YdbColumn,
					relationTableTsKey: undefined,
					isJson: false,
					selection: [],
				}
			}),
			...selectedExtras.map(({ tsKey, field }) => ({
				dbKey: field.fieldAlias,
				tsKey,
				field,
				relationTableTsKey: undefined,
				isJson: false,
				isExtra: true,
				selection: [],
			})),
		]

		const result = this.buildSelectQuery({
			table: aliasedTable(table, tableAlias),
			fields: {},
			fieldsFlat: selection.map(({ field }) => ({
				path: [],
				field,
			})) as YdbSelectedFieldsOrdered,
			where: and(joinOn, where),
			joins: undefined,
			orderBy,
			groupBy: undefined,
			having: undefined,
			limit,
			offset,
			distinct: false,
			distinctOn: undefined,
			selectionAliases: undefined,
			setOperators: [],
		})

		return {
			tableTsKey: tableConfig.tsName,
			sql: result,
			selection,
		}
	}

	async migrate(
		migrations: readonly YdbDialectMigration[],
		session: MigrationSessionInput,
		config: string | YdbDialectMigrationConfig = {}
	): Promise<void> {
		const migrationConfig = typeof config === 'string' ? { migrationsTable: config } : config
		const lockEnabled = migrationConfig.migrationLock !== false
		let lock: MigrationLockHandle | undefined
		let primaryError: unknown
		let releaseError: unknown

		try {
			if (lockEnabled) {
				await session.execute(yql.raw(buildMigrationLockTableBootstrapSql(migrationConfig)))
				lock = await acquireMigrationLock(session, migrationConfig)
			}

			await ensureMigrationHistoryTable(session, migrationConfig)

			const appliedRows = await session.values<
				[
					string,
					number | string,
					string,
					YdbMigrationStatus | null,
					number | string | null,
					number | string | null,
					string | null,
					string | null,
					number | string | null,
					number | string | null,
				]
			>(yql.raw(buildMigrationHistorySelectSql(migrationConfig)))
			const historyRows = appliedRows.map((row) => normalizeMigrationHistoryRow(row))
			const historyByHash = new Map(historyRows.map((row) => [row.hash, row]))
			const appliedHashes = new Set(
				historyRows.filter((row) => row.status === 'applied').map((row) => row.hash)
			)
			const orderedMigrations = [...migrations].sort(
				(left, right) => left.folderMillis - right.folderMillis
			)

			for (const migration of orderedMigrations) {
				if (appliedHashes.has(migration.hash)) {
					continue
				}

				const now = Date.now()
				const existingRow = historyByHash.get(migration.hash)
				if (existingRow) {
					assertMigrationRecoverable(existingRow, now, migrationConfig)
				}

				lock?.assertHealthy()

				const migrationName = deriveMigrationName(migration)
				const statements = migration.sql
					.map((statement) => statement.trim())
					.filter((statement) => statement !== '')
				const startedAt = Date.now()
				let statementsApplied = 0

				await session.execute(
					yql.raw(
						buildMigrationHistoryInsertSql(
							{
								hash: migration.hash,
								folderMillis: migration.folderMillis,
								name: migrationName,
								status: 'running',
								startedAt,
								ownerId: lock?.ownerId,
								statementsTotal: statements.length,
								statementsApplied,
							},
							migrationConfig
						)
					)
				)

				try {
					for (const statement of statements) {
						lock?.assertHealthy()
						await session.execute(yql.raw(statement))
						statementsApplied += 1
						await session.execute(
							yql.raw(
								buildMigrationHistoryInsertSql(
									{
										hash: migration.hash,
										folderMillis: migration.folderMillis,
										name: migrationName,
										status: 'running',
										startedAt,
										ownerId: lock?.ownerId,
										statementsTotal: statements.length,
										statementsApplied,
									},
									migrationConfig
								)
							)
						)
					}

					const finishedAt = Date.now()
					await session.execute(
						yql.raw(
							buildMigrationHistoryInsertSql(
								{
									hash: migration.hash,
									folderMillis: migration.folderMillis,
									name: migrationName,
									status: 'applied',
									startedAt,
									finishedAt,
									ownerId: lock?.ownerId,
									statementsTotal: statements.length,
									statementsApplied,
								},
								migrationConfig
							)
						)
					)

					appliedHashes.add(migration.hash)
					historyByHash.set(migration.hash, {
						hash: migration.hash,
						folderMillis: migration.folderMillis,
						name: migrationName,
						status: 'applied',
						startedAt,
						finishedAt,
						ownerId: lock?.ownerId,
						statementsTotal: statements.length,
						statementsApplied,
					})
				} catch (error) {
					const finishedAt = Date.now()
					const message = getErrorMessage(error)
					await session.execute(
						yql.raw(
							buildMigrationHistoryInsertSql(
								{
									hash: migration.hash,
									folderMillis: migration.folderMillis,
									name: migrationName,
									status: 'failed',
									startedAt,
									finishedAt,
									error: message.slice(0, 4096),
									ownerId: lock?.ownerId,
									statementsTotal: statements.length,
									statementsApplied,
								},
								migrationConfig
							)
						)
					)

					throw new Error(
						`YDB migration "${migrationName}" failed after ${statementsApplied}/${statements.length} statements: ${message}`,
						{ cause: error }
					)
				}
			}
		} catch (error) {
			primaryError = error
		} finally {
			if (lock) {
				try {
					await lock.release()
				} catch (error) {
					releaseError = error
				}
			}
		}

		if (primaryError) {
			throw primaryError
		}

		if (releaseError) {
			throw releaseError
		}
	}

	sqlToQuery(sqlValue: SQL, invokeSource?: 'indexes'): QueryWithTypings {
		return sqlValue.toQuery({
			casing: this.casing,
			escapeName: this.escapeName,
			escapeParam: this.escapeParam,
			escapeString: this.escapeString,
			prepareTyping: this.prepareTyping,
			invokeSource,
		})
	}
}
