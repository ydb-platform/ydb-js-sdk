import * as crypto from 'node:crypto'
import { getTableName } from 'drizzle-orm/table'
import type { YdbColumn } from '../ydb-core/columns/common.js'
import type { YdbIndex, YdbIndexConfig } from '../ydb-core/indexes.js'
import type { YdbPrimaryKey } from '../ydb-core/primary-keys.js'
import type {
	YdbColumnFamily,
	YdbColumnFamilyOptions,
	YdbTableOptionValue,
	YdbTableOptions,
	YdbTtl,
} from '../ydb-core/table-options.js'
import { getTableConfig } from '../ydb-core/table.utils.js'
import type { YdbTable, YdbTableWithColumns } from '../ydb-core/table.js'
import type { YdbUniqueConstraint } from '../ydb-core/unique-constraint.js'

export interface YdbMigrationTableConfig {
	migrationsTable?: string
	migrationsSchema?: string
	migrationsLockTable?: string
	migrationLock?: boolean | YdbMigrationLockConfig
	migrationRecovery?: YdbMigrationRecoveryConfig
}

export interface YdbMigrationLockConfig {
	table?: string
	key?: string
	ownerId?: string
	leaseMs?: number
	acquireTimeoutMs?: number
	retryIntervalMs?: number
}

export interface YdbMigrationRecoveryConfig {
	mode?: 'fail' | 'retry'
	staleRunningAfterMs?: number
}

export type YdbMigrationStatus = 'running' | 'applied' | 'failed'

export interface YdbMigrationHistoryRecord {
	hash: string
	folderMillis: number
	name: string
	status: YdbMigrationStatus
	startedAt?: number
	finishedAt?: number
	error?: string
	ownerId?: string
	statementsTotal?: number
	statementsApplied?: number
}

export interface YdbCreateTableOperation {
	kind: 'create_table'
	table: YdbTableWithColumns
	ifNotExists?: boolean
	temporary?: boolean | 'temp' | 'temporary'
}

export interface YdbDropTableOperation {
	kind: 'drop_table'
	table: string | YdbTable
	ifExists?: boolean
}

export interface YdbAnalyzeOperation {
	kind: 'analyze'
	table: string | YdbTable
	columns?: readonly (string | YdbColumn)[]
}

export interface YdbCreateViewOperation {
	kind: 'create_view'
	name: string
	query: string
	ifNotExists?: boolean
	options?: YdbCreateViewOptions
}

export interface YdbDropViewOperation {
	kind: 'drop_view'
	name: string
	ifExists?: boolean
}

export interface YdbCreateTopicOperation {
	kind: 'create_topic'
	name: string
	options?: YdbCreateTopicOptions
}

export interface YdbAlterTopicOperation {
	kind: 'alter_topic'
	name: string
	actions: [YdbAlterTopicAction, ...YdbAlterTopicAction[]]
}

export interface YdbDropTopicOperation {
	kind: 'drop_topic'
	name: string
}

export interface YdbCreateAsyncReplicationOperation {
	kind: 'create_async_replication'
	name: string
	targets: [YdbAsyncReplicationTarget, ...YdbAsyncReplicationTarget[]]
	options: YdbAsyncReplicationOptions
}

export interface YdbAlterAsyncReplicationOperation {
	kind: 'alter_async_replication'
	name: string
	options: YdbAlterAsyncReplicationOptions
}

export interface YdbDropAsyncReplicationOperation {
	kind: 'drop_async_replication'
	name: string
	cascade?: boolean
}

export interface YdbCreateTransferOperation {
	kind: 'create_transfer'
	name: string
	from: string
	to: string
	using: string
	options?: YdbTransferOptions
}

export interface YdbAlterTransferOperation {
	kind: 'alter_transfer'
	name: string
	using?: string
	options?: YdbAlterTransferOptions
}

export interface YdbDropTransferOperation {
	kind: 'drop_transfer'
	name: string
}

export interface YdbCreateSecretOperation {
	kind: 'create_secret'
	name: string
	value: string
}

export interface YdbCreateUserOperation {
	kind: 'create_user'
	name: string
	options?: YdbUserOptions
}

export interface YdbAlterUserOperation {
	kind: 'alter_user'
	name: string
	options: YdbUserOptions
}

export interface YdbDropUserOperation {
	kind: 'drop_user'
	names: [string, ...string[]]
	ifExists?: boolean
}

export interface YdbCreateGroupOperation {
	kind: 'create_group'
	name: string
	users?: readonly string[]
}

export interface YdbAlterGroupOperation {
	kind: 'alter_group'
	name: string
	action: 'add_user' | 'drop_user'
	users: [string, ...string[]]
}

export interface YdbDropGroupOperation {
	kind: 'drop_group'
	names: [string, ...string[]]
	ifExists?: boolean
}

export interface YdbGrantOperation {
	kind: 'grant'
	permissions: YdbAccessPermissions
	on: [string, ...string[]]
	to: [string, ...string[]]
	withGrantOption?: boolean
}

export interface YdbRevokeOperation {
	kind: 'revoke'
	permissions: YdbAccessPermissions
	on: [string, ...string[]]
	from: [string, ...string[]]
	grantOptionFor?: boolean
}

export interface YdbShowCreateOperation {
	kind: 'show_create'
	objectType: YdbShowCreateObjectType
	name: string
}

export interface YdbAddColumnsOperation {
	kind: 'add_columns'
	table: string | YdbTable
	columns: [YdbColumn, ...YdbColumn[]]
}

export interface YdbDropColumnsOperation {
	kind: 'drop_columns'
	table: string | YdbTable
	columns: [string, ...string[]]
}

export interface YdbAddIndexOperation {
	kind: 'add_index'
	table: string | YdbTable
	index: YdbIndex | YdbUniqueConstraint
}

export interface YdbDropIndexOperation {
	kind: 'drop_index'
	table: string | YdbTable
	name: string
}

export interface YdbSetTableOptionsOperation {
	kind: 'set_table_options'
	table: string | YdbTable
	options: Readonly<Record<string, YdbTableOptionValue>>
}

export interface YdbResetTableOptionsOperation {
	kind: 'reset_table_options'
	table: string | YdbTable
	names: [string, ...string[]]
}

export interface YdbAddColumnFamilyOperation {
	kind: 'add_column_family'
	table: string | YdbTable
	family: Pick<YdbColumnFamily['config'], 'name' | 'options'>
}

export interface YdbAlterColumnFamilyOperation {
	kind: 'alter_column_family'
	table: string | YdbTable
	name: string
	options: YdbColumnFamilyOptions
}

export interface YdbSetColumnFamilyOperation {
	kind: 'set_column_family'
	table: string | YdbTable
	familyName: string
	columns: [YdbColumn, ...YdbColumn[]] | [string, ...string[]]
}

export interface YdbRenameTableOperation {
	kind: 'rename_table'
	table: string | YdbTable
	to: string
}

export interface YdbAddChangefeedOperation {
	kind: 'add_changefeed'
	table: string | YdbTable
	name: string
	options: YdbChangefeedOptions
}

export interface YdbDropChangefeedOperation {
	kind: 'drop_changefeed'
	table: string | YdbTable
	name: string
}

export interface YdbAlterTableOperation {
	kind: 'alter_table'
	table: string | YdbTable
	actions: [YdbAlterTableAction, ...YdbAlterTableAction[]]
}

export type YdbMigrationOperation =
	| YdbCreateTableOperation
	| YdbDropTableOperation
	| YdbAnalyzeOperation
	| YdbCreateViewOperation
	| YdbDropViewOperation
	| YdbCreateTopicOperation
	| YdbAlterTopicOperation
	| YdbDropTopicOperation
	| YdbCreateAsyncReplicationOperation
	| YdbAlterAsyncReplicationOperation
	| YdbDropAsyncReplicationOperation
	| YdbCreateTransferOperation
	| YdbAlterTransferOperation
	| YdbDropTransferOperation
	| YdbCreateSecretOperation
	| YdbCreateUserOperation
	| YdbAlterUserOperation
	| YdbDropUserOperation
	| YdbCreateGroupOperation
	| YdbAlterGroupOperation
	| YdbDropGroupOperation
	| YdbGrantOperation
	| YdbRevokeOperation
	| YdbShowCreateOperation
	| YdbAddColumnsOperation
	| YdbDropColumnsOperation
	| YdbAddIndexOperation
	| YdbDropIndexOperation
	| YdbSetTableOptionsOperation
	| YdbResetTableOptionsOperation
	| YdbAddColumnFamilyOperation
	| YdbAlterColumnFamilyOperation
	| YdbSetColumnFamilyOperation
	| YdbRenameTableOperation
	| YdbAddChangefeedOperation
	| YdbDropChangefeedOperation
	| YdbAlterTableOperation

export interface YdbCreateViewOptions {
	ifNotExists?: boolean
	/**
	 * YDB currently requires security_invoker = TRUE for views.
	 * Defaults to true to generate executable view DDL.
	 */
	securityInvoker?: boolean
	options?: Readonly<Record<string, YdbTableOptionValue>>
}

export interface YdbTopicConsumer {
	name: string
	settings?: Readonly<Record<string, YdbTableOptionValue>>
}

export interface YdbCreateTopicOptions {
	consumers?: readonly YdbTopicConsumer[]
	settings?: Readonly<Record<string, YdbTableOptionValue>>
}

export interface YdbAsyncReplicationTarget {
	remote: string
	local: string
}

export type YdbAsyncReplicationConsistencyLevel = 'ROW' | 'GLOBAL'

export interface YdbAsyncReplicationOptions {
	connectionString?: string
	caCert?: string
	tokenSecretName?: string
	user?: string
	passwordSecretName?: string
	serviceAccountId?: string
	initialTokenSecretName?: string
	consistencyLevel?: YdbAsyncReplicationConsistencyLevel
	commitInterval?: string
	options?: Readonly<Record<string, YdbTableOptionValue>>
}

export interface YdbAlterAsyncReplicationOptions {
	state?: 'DONE'
	failoverMode?: 'FORCE'
	options?: Readonly<Record<string, YdbTableOptionValue>>
}

export interface YdbTransferOptions {
	connectionString?: string
	tokenSecretName?: string
	user?: string
	passwordSecretName?: string
	serviceAccountId?: string
	initialTokenSecretName?: string
	consumer?: string
	batchSizeBytes?: number
	flushInterval?: string
	options?: Readonly<Record<string, YdbTableOptionValue>>
}

export interface YdbAlterTransferOptions {
	state?: 'PAUSED' | 'ACTIVE'
	batchSizeBytes?: number
	flushInterval?: string
	options?: Readonly<Record<string, YdbTableOptionValue>>
}

export interface YdbUserOptions {
	password?: string | null
	login?: boolean
	withKeyword?: boolean
}

export type YdbAccessPermission =
	| string
	| { kind: 'all'; privileges?: boolean }
	| { kind: 'raw'; value: string }

export type YdbAccessPermissions =
	| YdbAccessPermission
	| readonly [YdbAccessPermission, ...YdbAccessPermission[]]

export type YdbShowCreateObjectType = 'table' | 'view' | 'topic' | 'async replication' | 'transfer'

export type YdbAlterTopicAction =
	| { kind: 'add_consumer'; consumer: YdbTopicConsumer }
	| { kind: 'drop_consumer'; name: string }
	| {
			kind: 'alter_consumer_set'
			name: string
			settings: Readonly<Record<string, YdbTableOptionValue>>
	  }
	| {
			kind: 'set_options'
			settings: Readonly<Record<string, YdbTableOptionValue>>
	  }

export type YdbChangefeedMode =
	| 'KEYS_ONLY'
	| 'UPDATES'
	| 'NEW_IMAGE'
	| 'OLD_IMAGE'
	| 'NEW_AND_OLD_IMAGES'

export type YdbChangefeedFormat = 'JSON' | 'DEBEZIUM_JSON'

export interface YdbChangefeedOptions {
	mode?: YdbChangefeedMode
	format?: YdbChangefeedFormat
	virtualTimestamps?: boolean
	barriersInterval?: string
	retentionPeriod?: string
	topicAutoPartitioning?: 'ENABLED' | 'DISABLED'
	topicMinActivePartitions?: number
	initialScan?: boolean
	options?: Readonly<Record<string, YdbTableOptionValue>>
}

export type YdbAlterTableAction =
	| { kind: 'add_column'; column: YdbColumn }
	| { kind: 'drop_column'; name: string }
	| { kind: 'add_index'; index: YdbIndex | YdbUniqueConstraint }
	| { kind: 'drop_index'; name: string }
	| {
			kind: 'set_table_options'
			options: Readonly<Record<string, YdbTableOptionValue>>
	  }
	| { kind: 'reset_table_options'; names: [string, ...string[]] }
	| {
			kind: 'add_column_family'
			family: Pick<YdbColumnFamily['config'], 'name' | 'options'>
	  }
	| {
			kind: 'alter_column_family'
			name: string
			options: YdbColumnFamilyOptions
	  }
	| {
			kind: 'set_column_family'
			familyName: string
			column: YdbColumn | string
	  }
	| { kind: 'rename_table'; to: string }
	| { kind: 'add_changefeed'; name: string; options: YdbChangefeedOptions }
	| { kind: 'drop_changefeed'; name: string }

export interface YdbInlineMigration {
	readonly name?: string
	readonly folderMillis?: number
	readonly hash?: string
	readonly breakpoints?: boolean
	readonly sql?: readonly string[]
	readonly operations?: readonly YdbMigrationOperation[]
}

export interface YdbNormalizedMigration {
	readonly name: string
	readonly folderMillis: number
	readonly hash: string
	readonly bps: boolean
	readonly sql: string[]
}

function escapeName(name: string): string {
	return `\`${name.replace(/`/g, '``')}\``
}

function escapeString(value: string): string {
	return `'${value.replace(/'/g, "''")}'`
}

function escapeDoubleQuoted(value: string): string {
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function getMigrationHashNamePart(hash: string): string {
	const sanitized = hash.replace(/[^a-zA-Z0-9]+/gu, '').slice(0, 12)
	return sanitized || crypto.createHash('sha256').update(hash).digest('hex').slice(0, 12)
}

export function buildStableMigrationName(
	migration: {
		readonly name?: string | undefined
		readonly folderMillis?: number | undefined
		readonly hash: string
	},
	prefix = 'migration'
): string {
	if (migration.name !== undefined && migration.name !== '') {
		return migration.name
	}

	const hashPart = getMigrationHashNamePart(migration.hash)
	if (typeof migration.folderMillis === 'number' && Number.isFinite(migration.folderMillis)) {
		return `${prefix}_${Math.trunc(migration.folderMillis)}_${hashPart}`
	}

	return `${prefix}_${hashPart}`
}

function renderOptionName(name: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
		throw new Error(`YDB migrate() invalid option name "${name}"`)
	}

	return name
}

function renderOptionNames(names: readonly string[]): string {
	return names.map((name) => renderOptionName(name)).join(', ')
}

function getObjectName(value: string | YdbTable): string {
	return typeof value === 'string' ? value : getTableName(value)
}

function getMigrationTableName(config: YdbMigrationTableConfig): string {
	const tableName = config.migrationsTable ?? '__drizzle_migrations'
	return config.migrationsSchema ? `${config.migrationsSchema}/${tableName}` : tableName
}

function getMigrationLockTableName(config: YdbMigrationTableConfig): string {
	const configuredTable =
		typeof config.migrationLock === 'object' ? config.migrationLock.table : undefined
	const tableName =
		config.migrationsLockTable ??
		configuredTable ??
		`${config.migrationsTable ?? '__drizzle_migrations'}_lock`
	return config.migrationsSchema ? `${config.migrationsSchema}/${tableName}` : tableName
}

function ensureSupportedColumn(column: YdbColumn): void {
	if ((column as any).generated !== undefined) {
		throw new Error(
			`YDB migrate() DDL generation does not support generated columns: "${column.name}"`
		)
	}
}

function renderColumnDefinition(column: YdbColumn, familyName?: string): string {
	ensureSupportedColumn(column)

	const parts = [escapeName(column.name), column.getSQLType()]
	if (familyName) {
		parts.push('FAMILY', escapeName(familyName))
	}

	if ((column as any).notNull === true) {
		parts.push('NOT NULL')
	}

	return parts.join(' ')
}

function getPrimaryKeyColumns(
	columns: readonly YdbColumn[],
	primaryKeys: readonly YdbPrimaryKey[]
): YdbColumn[] {
	const inlinePrimaryKeys = columns.filter((column) => (column as any).primary === true)

	if (inlinePrimaryKeys.length > 0 && primaryKeys.length > 0) {
		throw new Error(
			'YDB migrate() DDL generation found both inline and table-level primary keys'
		)
	}

	if (primaryKeys.length > 1) {
		throw new Error(
			'YDB migrate() DDL generation supports only one table-level primary key definition'
		)
	}

	return inlinePrimaryKeys.length > 0
		? inlinePrimaryKeys
		: [...(primaryKeys[0]?.config.columns ?? [])]
}

function isRawTableOptionValue(
	value: YdbTableOptionValue
): value is Extract<YdbTableOptionValue, { kind: 'raw' }> {
	return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'raw'
}

function renderTableOptionValue(value: YdbTableOptionValue): string {
	if (isRawTableOptionValue(value)) {
		return value.value
	}

	if (typeof value === 'number') {
		return String(value)
	}

	if (typeof value === 'boolean') {
		return value ? 'TRUE' : 'FALSE'
	}

	return value
}

function renderTableOptions(options: Readonly<Record<string, YdbTableOptionValue>>): string[] {
	return Object.entries(options).map(
		([key, value]) => `${renderOptionName(key)} = ${renderTableOptionValue(value)}`
	)
}

function renderStatementOptionValue(value: YdbTableOptionValue): string {
	if (isRawTableOptionValue(value)) {
		return value.value
	}

	if (typeof value === 'string') {
		return escapeString(value)
	}

	return renderTableOptionValue(value)
}

function renderStatementOptions(options: Readonly<Record<string, YdbTableOptionValue>>): string[] {
	return Object.entries(options).map(
		([key, value]) => `${renderOptionName(key)} = ${renderStatementOptionValue(value)}`
	)
}

function requireNonEmptyOptions(
	options: Readonly<Record<string, YdbTableOptionValue>>,
	context: string
): string[] {
	const rendered = renderTableOptions(options)
	if (rendered.length === 0) {
		throw new Error(`YDB migrate() ${context} requires at least one option`)
	}

	return rendered
}

function renderTtl(ttl: YdbTtl): string {
	const { column, actions, unit } = ttl.config
	const actionSql = actions
		.map((action) => {
			const interval = `Interval(${escapeDoubleQuoted(action.interval)})`

			if ('externalDataSource' in action) {
				return `${interval} TO EXTERNAL DATA SOURCE ${escapeName(action.externalDataSource)}`
			}

			return action.delete === true ? `${interval} DELETE` : interval
		})
		.join(', ')
	const unitSql = unit ? ` AS ${unit}` : ''

	return `${actionSql} ON ${escapeName(column.name)}${unitSql}`
}

function collectWithOptions(
	tableOptions: readonly YdbTableOptions[],
	ttls: readonly YdbTtl[]
): string[] {
	const rendered: string[] = []
	const used = new Set<string>()

	for (const tableOption of tableOptions) {
		for (const [key, value] of Object.entries(tableOption.config.options)) {
			if (used.has(key)) {
				throw new Error(`YDB migrate() duplicate table option "${key}"`)
			}
			used.add(key)
			rendered.push(`${renderOptionName(key)} = ${renderTableOptionValue(value)}`)
		}
	}

	if (ttls.length > 1) {
		throw new Error('YDB migrate() supports only one TTL definition per table')
	}

	if (ttls.length === 1) {
		if (used.has('TTL')) {
			throw new Error('YDB migrate() duplicate table option "TTL"')
		}
		rendered.push(`TTL = ${renderTtl(ttls[0]!)}`)
	}

	return rendered
}

function renderColumnFamilyOptions(options: YdbColumnFamilyOptions): string[] {
	const rendered: string[] = []
	if (options.data !== undefined) {
		rendered.push(`DATA = ${escapeDoubleQuoted(options.data)}`)
	}
	if (options.compression !== undefined) {
		rendered.push(`COMPRESSION = ${escapeDoubleQuoted(options.compression)}`)
	}
	if (options.compressionLevel !== undefined) {
		rendered.push(`COMPRESSION_LEVEL = ${String(options.compressionLevel)}`)
	}
	return rendered
}

function renderColumnFamilyAlterActions(name: string, options: YdbColumnFamilyOptions): string[] {
	const familyName = escapeName(name)
	const rendered: string[] = []
	if (options.data !== undefined) {
		rendered.push(`ALTER FAMILY ${familyName} SET DATA ${escapeDoubleQuoted(options.data)}`)
	}
	if (options.compression !== undefined) {
		rendered.push(
			`ALTER FAMILY ${familyName} SET COMPRESSION ${escapeDoubleQuoted(options.compression)}`
		)
	}
	if (options.compressionLevel !== undefined) {
		rendered.push(
			`ALTER FAMILY ${familyName} SET COMPRESSION_LEVEL ${String(options.compressionLevel)}`
		)
	}
	return rendered
}

function renderColumnFamilyDefinition(
	family: Pick<YdbColumnFamily['config'], 'name' | 'options'>
): string {
	const options = renderColumnFamilyOptions(family.options)
	return options.length > 0
		? `FAMILY ${escapeName(family.name)} (${options.join(', ')})`
		: `FAMILY ${escapeName(family.name)}`
}

function getColumnFamilyByColumnName(
	columnFamilies: readonly YdbColumnFamily[]
): Map<string, string> {
	const familyByColumn = new Map<string, string>()
	const usedFamilyNames = new Set<string>()

	for (const family of columnFamilies) {
		if (usedFamilyNames.has(family.config.name)) {
			throw new Error(`YDB migrate() duplicate column family "${family.config.name}"`)
		}
		usedFamilyNames.add(family.config.name)

		for (const column of family.config.columns) {
			const existing = familyByColumn.get(column.name)
			if (existing) {
				throw new Error(
					`YDB migrate() column "${column.name}" is assigned to both "${existing}" and "${family.config.name}" families`
				)
			}

			familyByColumn.set(column.name, family.config.name)
		}
	}

	return familyByColumn
}

function renderPartitioning(
	partitioning: ReturnType<typeof getTableConfig>['partitioning']
): string | undefined {
	if (partitioning.length === 0) {
		return undefined
	}

	if (partitioning.length > 1) {
		throw new Error('YDB migrate() supports only one PARTITION BY definition per table')
	}

	const partitioningConfig = partitioning[0]!.config
	return `PARTITION BY HASH(${partitioningConfig.columns.map((column) => escapeName(column.name)).join(', ')})`
}

function renderIndexConfig(config: YdbIndexConfig): string {
	const fragments = [
		'INDEX',
		escapeName(
			config.name ??
				`${getTableName(config.table)}_${config.columns.map((column) => column.name).join('_')}_idx`
		),
		config.locality,
	]

	if (config.unique) {
		fragments.push('UNIQUE')
	}

	fragments.push(config.sync)

	if (config.indexType && config.indexType !== 'secondary') {
		fragments.push('USING', config.indexType)
	}

	fragments.push(`ON (${config.columns.map((column) => escapeName(column.name)).join(', ')})`)

	if (config.cover.length > 0) {
		fragments.push(
			`COVER (${config.cover.map((column) => escapeName(column.name)).join(', ')})`
		)
	}

	const withEntries = Object.entries(config.withOptions)
	if (withEntries.length > 0) {
		fragments.push(
			`WITH (${withEntries.map(([key, value]) => `${renderOptionName(key)} = ${typeof value === 'string' ? escapeString(value) : String(value)}`).join(', ')})`
		)
	}

	return fragments.join(' ')
}

function renderAddIndexAction(index: YdbIndex | YdbUniqueConstraint): string {
	const rendered =
		'config' in index && 'unique' in index.config
			? renderIndexConfig(index.config)
			: renderIndexConfig(uniqueConstraintToIndex(index as YdbUniqueConstraint))

	if (rendered.includes(' UNIQUE ')) {
		throw new Error(
			'YDB migrate() cannot add UNIQUE indexes to existing tables; create them inline in CREATE TABLE'
		)
	}

	return `ADD INDEX ${rendered.replace(/^INDEX\s+/u, '')}`
}

function uniqueConstraintToIndex(constraint: YdbUniqueConstraint): YdbIndexConfig {
	return {
		name: constraint.config.name,
		table: constraint.config.table,
		columns: constraint.config.columns,
		unique: true,
		locality: 'GLOBAL',
		sync: 'SYNC',
		indexType: undefined,
		cover: [],
		withOptions: {},
	}
}

function renderColumnsList(columns: readonly (string | YdbColumn)[]): string {
	return columns
		.map((column) => escapeName(typeof column === 'string' ? column : column.name))
		.join(', ')
}

function renderTopicConsumer(consumer: YdbTopicConsumer): string {
	const settings = consumer.settings ? renderTableOptions(consumer.settings) : []
	return settings.length > 0
		? `CONSUMER ${escapeName(consumer.name)} WITH (${settings.join(', ')})`
		: `CONSUMER ${escapeName(consumer.name)}`
}

function renderAlterTopicAction(action: YdbAlterTopicAction): string {
	switch (action.kind) {
		case 'add_consumer':
			return `ADD ${renderTopicConsumer(action.consumer)}`
		case 'drop_consumer':
			return `DROP CONSUMER ${escapeName(action.name)}`
		case 'alter_consumer_set':
			return `ALTER CONSUMER ${escapeName(action.name)} SET (${requireNonEmptyOptions(action.settings, 'ALTER TOPIC ALTER CONSUMER SET').join(', ')})`
		case 'set_options':
			return `SET (${requireNonEmptyOptions(action.settings, 'ALTER TOPIC SET').join(', ')})`
	}
}

function addIntervalOption(
	target: Record<string, YdbTableOptionValue>,
	key: string,
	value: string | undefined
): void {
	if (value !== undefined) {
		target[key] = { kind: 'raw', value: `Interval(${escapeString(value)})` }
	}
}

function normalizeAsyncReplicationOptions(
	options: YdbAsyncReplicationOptions
): Record<string, YdbTableOptionValue> {
	const rendered: Record<string, YdbTableOptionValue> = {
		...(options.options ?? {}),
	}

	if (options.connectionString !== undefined)
		rendered['CONNECTION_STRING'] = options.connectionString
	if (options.caCert !== undefined) rendered['CA_CERT'] = options.caCert
	if (options.tokenSecretName !== undefined)
		rendered['TOKEN_SECRET_NAME'] = options.tokenSecretName
	if (options.user !== undefined) rendered['USER'] = options.user
	if (options.passwordSecretName !== undefined)
		rendered['PASSWORD_SECRET_NAME'] = options.passwordSecretName
	if (options.serviceAccountId !== undefined)
		rendered['SERVICE_ACCOUNT_ID'] = options.serviceAccountId
	if (options.initialTokenSecretName !== undefined)
		rendered['INITIAL_TOKEN_SECRET_NAME'] = options.initialTokenSecretName
	if (options.consistencyLevel !== undefined)
		rendered['CONSISTENCY_LEVEL'] = options.consistencyLevel
	addIntervalOption(rendered, 'COMMIT_INTERVAL', options.commitInterval)

	return rendered
}

function normalizeAlterAsyncReplicationOptions(
	options: YdbAlterAsyncReplicationOptions
): Record<string, YdbTableOptionValue> {
	const rendered: Record<string, YdbTableOptionValue> = {
		...(options.options ?? {}),
	}

	if (options.state !== undefined) rendered['STATE'] = options.state
	if (options.failoverMode !== undefined) rendered['FAILOVER_MODE'] = options.failoverMode

	return rendered
}

function normalizeTransferOptions(
	options: YdbTransferOptions
): Record<string, YdbTableOptionValue> {
	const rendered: Record<string, YdbTableOptionValue> = {
		...(options.options ?? {}),
	}

	if (options.connectionString !== undefined)
		rendered['CONNECTION_STRING'] = options.connectionString
	if (options.tokenSecretName !== undefined)
		rendered['TOKEN_SECRET_NAME'] = options.tokenSecretName
	if (options.user !== undefined) rendered['USER'] = options.user
	if (options.passwordSecretName !== undefined)
		rendered['PASSWORD_SECRET_NAME'] = options.passwordSecretName
	if (options.serviceAccountId !== undefined)
		rendered['SERVICE_ACCOUNT_ID'] = options.serviceAccountId
	if (options.initialTokenSecretName !== undefined)
		rendered['INITIAL_TOKEN_SECRET_NAME'] = options.initialTokenSecretName
	if (options.consumer !== undefined) rendered['CONSUMER'] = options.consumer
	if (options.batchSizeBytes !== undefined) rendered['BATCH_SIZE_BYTES'] = options.batchSizeBytes
	addIntervalOption(rendered, 'FLUSH_INTERVAL', options.flushInterval)

	return rendered
}

function normalizeAlterTransferOptions(
	options: YdbAlterTransferOptions
): Record<string, YdbTableOptionValue> {
	const rendered: Record<string, YdbTableOptionValue> = {
		...(options.options ?? {}),
	}

	if (options.state !== undefined) rendered['STATE'] = options.state
	if (options.batchSizeBytes !== undefined) rendered['BATCH_SIZE_BYTES'] = options.batchSizeBytes
	addIntervalOption(rendered, 'FLUSH_INTERVAL', options.flushInterval)

	return rendered
}

function renderAdminOptions(
	options: Readonly<Record<string, YdbTableOptionValue>>,
	context: string
): string {
	const rendered = renderStatementOptions(options)
	if (rendered.length === 0) {
		throw new Error(`YDB migrate() ${context} requires at least one option`)
	}

	return rendered.join(', ')
}

function renderUserOptions(options: YdbUserOptions = {}): string {
	const rendered: string[] = []
	if ('password' in options) {
		rendered.push(
			options.password === null
				? 'PASSWORD NULL'
				: `PASSWORD ${escapeString(options.password ?? '')}`
		)
	}
	if (options.login !== undefined) {
		rendered.push(options.login ? 'LOGIN' : 'NOLOGIN')
	}

	return rendered.join(' ')
}

function renderRoleList(values: readonly string[]): string {
	return values.map((value) => escapeName(value)).join(', ')
}

function renderAccessPermission(permission: YdbAccessPermission): string {
	if (typeof permission !== 'string') {
		if (permission.kind === 'all') {
			return permission.privileges ? 'ALL PRIVILEGES' : 'ALL'
		}

		return permission.value
	}

	if (permission.includes('.')) {
		return escapeString(permission)
	}

	if (!/^[A-Za-z]+(?:\s+[A-Za-z]+)*$/u.test(permission)) {
		throw new Error(`YDB migrate() invalid permission "${permission}"`)
	}

	return permission.toUpperCase()
}

function renderAccessPermissions(permissions: YdbAccessPermissions): string {
	const list = Array.isArray(permissions) ? permissions : [permissions]
	if (list.length === 0) {
		throw new Error('YDB migrate() ACL statement requires permissions')
	}

	return list.map((permission) => renderAccessPermission(permission)).join(', ')
}

function renderShowCreateObjectType(type: YdbShowCreateObjectType): string {
	return type.toUpperCase()
}

function normalizeChangefeedOptions(
	options: YdbChangefeedOptions
): Record<string, YdbTableOptionValue> {
	const rendered: Record<string, YdbTableOptionValue> = {
		...(options.options ?? {}),
	}

	if (options.mode !== undefined) rendered['MODE'] = options.mode
	if (options.format !== undefined) rendered['FORMAT'] = options.format
	if (options.virtualTimestamps !== undefined)
		rendered['VIRTUAL_TIMESTAMPS'] = options.virtualTimestamps
	if (options.barriersInterval !== undefined)
		rendered['BARRIERS_INTERVAL'] = {
			kind: 'raw',
			value: `Interval(${escapeString(options.barriersInterval)})`,
		}
	if (options.retentionPeriod !== undefined)
		rendered['RETENTION_PERIOD'] = {
			kind: 'raw',
			value: `Interval(${escapeString(options.retentionPeriod)})`,
		}
	if (options.topicAutoPartitioning !== undefined)
		rendered['TOPIC_AUTO_PARTITIONING'] = options.topicAutoPartitioning
	if (options.topicMinActivePartitions !== undefined)
		rendered['TOPIC_MIN_ACTIVE_PARTITIONS'] = options.topicMinActivePartitions
	if (options.initialScan !== undefined) rendered['INITIAL_SCAN'] = options.initialScan

	return rendered
}

function renderChangefeedOptions(options: YdbChangefeedOptions): string {
	const renderedOptions = Object.entries(normalizeChangefeedOptions(options)).map(
		([key, value]) => {
			if (isRawTableOptionValue(value)) {
				return `${renderOptionName(key)} = ${value.value}`
			}

			if (typeof value === 'string') {
				return `${renderOptionName(key)} = ${escapeString(value)}`
			}

			return `${renderOptionName(key)} = ${renderTableOptionValue(value)}`
		}
	)

	if (renderedOptions.length === 0) {
		throw new Error('YDB migrate() CHANGEFEED WITH requires at least one option')
	}

	return renderedOptions.join(', ')
}

function renderAlterTableAction(action: YdbAlterTableAction): string[] {
	switch (action.kind) {
		case 'add_column':
			return [`ADD COLUMN ${renderColumnDefinition(action.column)}`]
		case 'drop_column':
			return [`DROP COLUMN ${escapeName(action.name)}`]
		case 'add_index':
			return [renderAddIndexAction(action.index)]
		case 'drop_index':
			return [`DROP INDEX ${escapeName(action.name)}`]
		case 'set_table_options':
			return [`SET (${requireNonEmptyOptions(action.options, 'ALTER TABLE SET').join(', ')})`]
		case 'reset_table_options':
			return [`RESET (${renderOptionNames(action.names)})`]
		case 'add_column_family':
			return [`ADD ${renderColumnFamilyDefinition(action.family)}`]
		case 'alter_column_family':
			return renderColumnFamilyAlterActions(action.name, action.options)
		case 'set_column_family': {
			const columnName =
				typeof action.column === 'string' ? action.column : action.column.name
			return [
				`ALTER COLUMN ${escapeName(columnName)} SET FAMILY ${escapeName(action.familyName)}`,
			]
		}
		case 'rename_table':
			return [`RENAME TO ${escapeName(action.to)}`]
		case 'add_changefeed':
			return [
				`ADD CHANGEFEED ${escapeName(action.name)} WITH (${renderChangefeedOptions(action.options)})`,
			]
		case 'drop_changefeed':
			return [`DROP CHANGEFEED ${escapeName(action.name)}`]
	}
}

type DefinedOptions<T extends Record<string, unknown>> = {
	[K in keyof T]?: Exclude<T[K], undefined>
}

function definedOptions<T extends Record<string, unknown>>(options: T): DefinedOptions<T> {
	const result: Partial<Record<keyof T, unknown>> = {}

	for (const [key, value] of Object.entries(options) as Array<[keyof T, T[keyof T]]>) {
		if (value !== undefined) {
			result[key] = value
		}
	}

	return result as DefinedOptions<T>
}

export function buildMigrationTableBootstrapSql(config: YdbMigrationTableConfig = {}): string {
	const migrationTableName = getMigrationTableName(config)

	return [
		`CREATE TABLE IF NOT EXISTS ${escapeName(migrationTableName)} (`,
		`  ${escapeName('hash')} Utf8 NOT NULL,`,
		`  ${escapeName('created_at')} Int64 NOT NULL,`,
		`  ${escapeName('name')} Utf8 NOT NULL,`,
		`  ${escapeName('status')} Utf8,`,
		`  ${escapeName('started_at')} Int64,`,
		`  ${escapeName('finished_at')} Int64,`,
		`  ${escapeName('error')} Utf8,`,
		`  ${escapeName('owner_id')} Utf8,`,
		`  ${escapeName('statements_total')} Uint32,`,
		`  ${escapeName('statements_applied')} Uint32,`,
		`  PRIMARY KEY (${escapeName('hash')})`,
		`)`,
	].join('\n')
}

export function buildMigrationHistoryMetadataProbeSql(
	config: YdbMigrationTableConfig = {}
): string {
	const migrationTableName = getMigrationTableName(config)
	return `SELECT ${escapeName('status')} FROM ${escapeName(migrationTableName)} LIMIT 1`
}

export function buildMigrationHistoryMetadataColumnSql(
	config: YdbMigrationTableConfig = {}
): string[] {
	const migrationTableName = escapeName(getMigrationTableName(config))
	return [
		`ALTER TABLE ${migrationTableName} ADD COLUMN ${escapeName('status')} Utf8`,
		`ALTER TABLE ${migrationTableName} ADD COLUMN ${escapeName('started_at')} Int64`,
		`ALTER TABLE ${migrationTableName} ADD COLUMN ${escapeName('finished_at')} Int64`,
		`ALTER TABLE ${migrationTableName} ADD COLUMN ${escapeName('error')} Utf8`,
		`ALTER TABLE ${migrationTableName} ADD COLUMN ${escapeName('owner_id')} Utf8`,
		`ALTER TABLE ${migrationTableName} ADD COLUMN ${escapeName('statements_total')} Uint32`,
		`ALTER TABLE ${migrationTableName} ADD COLUMN ${escapeName('statements_applied')} Uint32`,
	]
}

export function buildMigrationLockTableBootstrapSql(config: YdbMigrationTableConfig = {}): string {
	const lockTableName = getMigrationLockTableName(config)

	return [
		`CREATE TABLE IF NOT EXISTS ${escapeName(lockTableName)} (`,
		`  ${escapeName('lock_key')} Utf8 NOT NULL,`,
		`  ${escapeName('owner_id')} Utf8 NOT NULL,`,
		`  ${escapeName('acquired_at')} Int64 NOT NULL,`,
		`  ${escapeName('heartbeat_at')} Int64 NOT NULL,`,
		`  ${escapeName('expires_at')} Int64 NOT NULL,`,
		`  PRIMARY KEY (${escapeName('lock_key')})`,
		`)`,
	].join('\n')
}

export function buildCreateTableSql(
	table: YdbTableWithColumns,
	options: {
		ifNotExists?: boolean
		temporary?: boolean | 'temp' | 'temporary'
	} = {}
): string {
	const {
		columns,
		indexes,
		primaryKeys,
		uniqueConstraints,
		tableOptions,
		partitioning,
		ttls,
		columnFamilies,
	} = getTableConfig(table)

	const primaryKeyColumns = getPrimaryKeyColumns(columns, primaryKeys)
	if (primaryKeyColumns.length === 0) {
		throw new Error(
			`YDB migrate() CREATE TABLE requires a primary key for "${getTableName(table)}"`
		)
	}

	const familyByColumnName = getColumnFamilyByColumnName(columnFamilies)
	const definitions = [
		...columns.map((column) =>
			renderColumnDefinition(column, familyByColumnName.get(column.name))
		),
		...indexes.map((index) => renderIndexConfig(index.config)),
		...uniqueConstraints.map((constraint) =>
			renderIndexConfig(uniqueConstraintToIndex(constraint))
		),
		...columnFamilies.map((family) => renderColumnFamilyDefinition(family.config)),
		`PRIMARY KEY (${primaryKeyColumns.map((column) => escapeName(column.name)).join(', ')})`,
	]
	const partitioningSql = renderPartitioning(partitioning)
	const withOptions = collectWithOptions(tableOptions, ttls)

	const temporarySql =
		options.temporary === true
			? 'TEMPORARY '
			: options.temporary
				? `${options.temporary.toUpperCase()} `
				: ''
	const parts = [
		`CREATE ${temporarySql}TABLE ${options.ifNotExists ? 'IF NOT EXISTS ' : ''}${escapeName(getTableName(table))} (`,
		definitions.map((definition) => `  ${definition}`).join(',\n'),
		`)`,
	]

	if (partitioningSql) {
		parts.push(partitioningSql)
	}

	if (withOptions.length > 0) {
		parts.push('WITH (', withOptions.map((option) => `  ${option}`).join(',\n'), ')')
	}

	return parts.join('\n')
}

export function buildDropTableSql(
	table: string | YdbTable,
	options: { ifExists?: boolean } = {}
): string {
	return `DROP TABLE ${options.ifExists ? 'IF EXISTS ' : ''}${escapeName(getObjectName(table))}`
}

export function buildAnalyzeSql(
	table: string | YdbTable,
	columns?: readonly (string | YdbColumn)[]
): string {
	const columnSql = columns && columns.length > 0 ? ` (${renderColumnsList(columns)})` : ''
	return `ANALYZE ${escapeName(getObjectName(table))}${columnSql}`
}

export function buildCreateViewSql(
	name: string,
	query: string,
	options: YdbCreateViewOptions = {}
): string {
	const viewOptions: Record<string, YdbTableOptionValue> = {
		security_invoker: options.securityInvoker ?? true,
		...(options.options ?? {}),
	}
	const renderedOptions = renderTableOptions(viewOptions)
	const ifNotExists = options.ifNotExists ? 'IF NOT EXISTS ' : ''
	return `CREATE VIEW ${ifNotExists}${escapeName(name)} WITH (${renderedOptions.join(', ')}) AS ${query}`
}

export function buildDropViewSql(name: string, options: { ifExists?: boolean } = {}): string {
	return `DROP VIEW ${options.ifExists ? 'IF EXISTS ' : ''}${escapeName(name)}`
}

export function buildCreateTopicSql(name: string, options: YdbCreateTopicOptions = {}): string {
	const consumers = (options.consumers ?? []).map((consumer) => renderTopicConsumer(consumer))
	const settings = renderTableOptions(options.settings ?? {})
	const consumersSql = consumers.length > 0 ? ` (\n  ${consumers.join(',\n  ')}\n)` : ''
	const settingsSql = settings.length > 0 ? ` WITH (\n  ${settings.join(',\n  ')}\n)` : ''
	return `CREATE TOPIC ${escapeName(name)}${consumersSql}${settingsSql}`
}

export function buildAlterTopicSql(
	name: string,
	actions: [YdbAlterTopicAction, ...YdbAlterTopicAction[]]
): string {
	return `ALTER TOPIC ${escapeName(name)} ${actions.map((action) => renderAlterTopicAction(action)).join(', ')}`
}

export function buildDropTopicSql(name: string): string {
	return `DROP TOPIC ${escapeName(name)}`
}

export function buildCreateAsyncReplicationSql(
	name: string,
	targets: [YdbAsyncReplicationTarget, ...YdbAsyncReplicationTarget[]],
	options: YdbAsyncReplicationOptions
): string {
	const targetSql = targets
		.map((target) => `${escapeName(target.remote)} AS ${escapeName(target.local)}`)
		.join(', ')
	const optionSql = renderAdminOptions(
		normalizeAsyncReplicationOptions(options),
		'CREATE ASYNC REPLICATION WITH'
	)

	return `CREATE ASYNC REPLICATION ${escapeName(name)} FOR ${targetSql} WITH (${optionSql})`
}

export function buildAlterAsyncReplicationSql(
	name: string,
	options: YdbAlterAsyncReplicationOptions
): string {
	const optionSql = renderAdminOptions(
		normalizeAlterAsyncReplicationOptions(options),
		'ALTER ASYNC REPLICATION SET'
	)
	return `ALTER ASYNC REPLICATION ${escapeName(name)} SET (${optionSql})`
}

export function buildDropAsyncReplicationSql(
	name: string,
	options: { cascade?: boolean } = {}
): string {
	return `DROP ASYNC REPLICATION ${escapeName(name)}${options.cascade ? ' CASCADE' : ''}`
}

export function buildCreateTransferSql(
	name: string,
	from: string,
	to: string,
	using: string,
	options: YdbTransferOptions = {}
): string {
	const renderedOptions = renderStatementOptions(normalizeTransferOptions(options))
	const withSql = renderedOptions.length > 0 ? ` WITH (${renderedOptions.join(', ')})` : ''
	return `CREATE TRANSFER ${escapeName(name)} FROM ${escapeName(from)} TO ${escapeName(to)} USING ${using}${withSql}`
}

export function buildAlterTransferSql(
	name: string,
	config: { using?: string; options?: YdbAlterTransferOptions }
): string {
	if (config.using && config.options) {
		throw new Error(
			'YDB migrate() ALTER TRANSFER supports either SET USING or SET options, not both'
		)
	}

	if (config.using) {
		return `ALTER TRANSFER ${escapeName(name)} SET USING ${config.using}`
	}

	if (!config.options) {
		throw new Error('YDB migrate() ALTER TRANSFER requires using or options')
	}

	const optionSql = renderAdminOptions(
		normalizeAlterTransferOptions(config.options),
		'ALTER TRANSFER SET'
	)
	return `ALTER TRANSFER ${escapeName(name)} SET (${optionSql})`
}

export function buildDropTransferSql(name: string): string {
	return `DROP TRANSFER ${escapeName(name)}`
}

export function buildCreateSecretSql(name: string, value: string): string {
	return `CREATE OBJECT ${escapeName(name)} (TYPE SECRET) WITH value=${escapeDoubleQuoted(value)}`
}

export function buildCreateUserSql(name: string, options: YdbUserOptions = {}): string {
	const optionSql = renderUserOptions(options)
	return `CREATE USER ${escapeName(name)}${optionSql ? ` ${optionSql}` : ''}`
}

export function buildAlterUserSql(name: string, options: YdbUserOptions): string {
	const optionSql = renderUserOptions(options)
	if (!optionSql) {
		throw new Error('YDB migrate() ALTER USER requires at least one option')
	}

	return `ALTER USER ${escapeName(name)}${options.withKeyword ? ' WITH' : ''} ${optionSql}`
}

export function buildDropUserSql(
	names: [string, ...string[]],
	options: { ifExists?: boolean } = {}
): string {
	return `DROP USER ${options.ifExists ? 'IF EXISTS ' : ''}${renderRoleList(names)}`
}

export function buildCreateGroupSql(
	name: string,
	options: { users?: readonly string[] } = {}
): string {
	const usersSql =
		options.users && options.users.length > 0
			? ` WITH USER ${renderRoleList(options.users)}`
			: ''
	return `CREATE GROUP ${escapeName(name)}${usersSql}`
}

export function buildAlterGroupSql(
	name: string,
	action: 'add_user' | 'drop_user',
	users: [string, ...string[]]
): string {
	return `ALTER GROUP ${escapeName(name)} ${action === 'add_user' ? 'ADD' : 'DROP'} USER ${renderRoleList(users)}`
}

export function buildDropGroupSql(
	names: [string, ...string[]],
	options: { ifExists?: boolean } = {}
): string {
	return `DROP GROUP ${options.ifExists ? 'IF EXISTS ' : ''}${renderRoleList(names)}`
}

export function buildGrantSql(config: {
	permissions: YdbAccessPermissions
	on: [string, ...string[]]
	to: [string, ...string[]]
	withGrantOption?: boolean
}): string {
	return `GRANT ${renderAccessPermissions(config.permissions)} ON ${renderRoleList(config.on)} TO ${renderRoleList(config.to)}${config.withGrantOption ? ' WITH GRANT OPTION' : ''}`
}

export function buildRevokeSql(config: {
	permissions: YdbAccessPermissions
	on: [string, ...string[]]
	from: [string, ...string[]]
	grantOptionFor?: boolean
}): string {
	return `REVOKE ${config.grantOptionFor ? 'GRANT OPTION FOR ' : ''}${renderAccessPermissions(config.permissions)} ON ${renderRoleList(config.on)} FROM ${renderRoleList(config.from)}`
}

export function buildShowCreateSql(objectType: YdbShowCreateObjectType, name: string): string {
	return `SHOW CREATE ${renderShowCreateObjectType(objectType)} ${escapeName(name)}`
}

export function buildAddColumnsSql(
	table: string | YdbTable,
	columns: [YdbColumn, ...YdbColumn[]]
): string[] {
	return columns.map(
		(column) =>
			`ALTER TABLE ${escapeName(getObjectName(table))} ADD COLUMN ${renderColumnDefinition(column)}`
	)
}

export function buildDropColumnsSql(
	table: string | YdbTable,
	columns: [string, ...string[]]
): string[] {
	return columns.map(
		(column) =>
			`ALTER TABLE ${escapeName(getObjectName(table))} DROP COLUMN ${escapeName(column)}`
	)
}

export function buildAddIndexSql(
	table: string | YdbTable,
	index: YdbIndex | YdbUniqueConstraint
): string {
	return `ALTER TABLE ${escapeName(getObjectName(table))} ${renderAddIndexAction(index)}`
}

export function buildDropIndexSql(table: string | YdbTable, name: string): string {
	return `ALTER TABLE ${escapeName(getObjectName(table))} DROP INDEX ${escapeName(name)}`
}

export function buildAlterTableSetOptionsSql(
	table: string | YdbTable,
	options: Readonly<Record<string, YdbTableOptionValue>>
): string {
	const renderedOptions = requireNonEmptyOptions(options, 'ALTER TABLE SET')
	return `ALTER TABLE ${escapeName(getObjectName(table))} SET (${renderedOptions.join(', ')})`
}

export function buildAlterTableResetOptionsSql(
	table: string | YdbTable,
	names: [string, ...string[]]
): string {
	return `ALTER TABLE ${escapeName(getObjectName(table))} RESET (${renderOptionNames(names)})`
}

export function buildAddColumnFamilySql(
	table: string | YdbTable,
	family: Pick<YdbColumnFamily['config'], 'name' | 'options'>
): string {
	return `ALTER TABLE ${escapeName(getObjectName(table))} ADD ${renderColumnFamilyDefinition(family)}`
}

export function buildAlterColumnFamilySql(
	table: string | YdbTable,
	name: string,
	options: YdbColumnFamilyOptions
): string {
	const actions = renderColumnFamilyAlterActions(name, options)
	if (actions.length === 0) {
		throw new Error('YDB migrate() ALTER FAMILY requires at least one option')
	}

	return `ALTER TABLE ${escapeName(getObjectName(table))} ${actions.join(', ')}`
}

export function buildAlterColumnSetFamilySql(
	table: string | YdbTable,
	columns: [YdbColumn, ...YdbColumn[]] | [string, ...string[]],
	familyName: string
): string[] {
	return columns.map((column) => {
		const columnName = typeof column === 'string' ? column : column.name
		return `ALTER TABLE ${escapeName(getObjectName(table))} ALTER COLUMN ${escapeName(columnName)} SET FAMILY ${escapeName(familyName)}`
	})
}

export function buildRenameTableSql(table: string | YdbTable, to: string): string {
	return `ALTER TABLE ${escapeName(getObjectName(table))} RENAME TO ${escapeName(to)}`
}

export function buildAddChangefeedSql(
	table: string | YdbTable,
	name: string,
	options: YdbChangefeedOptions
): string {
	return `ALTER TABLE ${escapeName(getObjectName(table))} ADD CHANGEFEED ${escapeName(name)} WITH (${renderChangefeedOptions(options)})`
}

export function buildDropChangefeedSql(table: string | YdbTable, name: string): string {
	return `ALTER TABLE ${escapeName(getObjectName(table))} DROP CHANGEFEED ${escapeName(name)}`
}

export function buildAlterTableSql(
	table: string | YdbTable,
	actions: [YdbAlterTableAction, ...YdbAlterTableAction[]]
): string {
	const rendered = actions.flatMap((action) => renderAlterTableAction(action))
	if (rendered.length === 0) {
		throw new Error('YDB migrate() ALTER TABLE requires at least one action')
	}

	return `ALTER TABLE ${escapeName(getObjectName(table))} ${rendered.join(', ')}`
}

export function buildMigrationSql(operations: readonly YdbMigrationOperation[]): string[] {
	const statements: string[] = []

	for (const operation of operations) {
		switch (operation.kind) {
			case 'create_table':
				statements.push(
					buildCreateTableSql(
						operation.table,
						definedOptions({
							ifNotExists: operation.ifNotExists,
							temporary: operation.temporary,
						})
					)
				)
				break
			case 'drop_table':
				statements.push(
					buildDropTableSql(
						operation.table,
						definedOptions({ ifExists: operation.ifExists })
					)
				)
				break
			case 'analyze':
				statements.push(buildAnalyzeSql(operation.table, operation.columns))
				break
			case 'create_view':
				const createViewOptions: YdbCreateViewOptions = { ...operation.options }
				const createViewIfNotExists =
					operation.ifNotExists ?? operation.options?.ifNotExists
				if (createViewIfNotExists !== undefined) {
					createViewOptions.ifNotExists = createViewIfNotExists
				}
				statements.push(
					buildCreateViewSql(operation.name, operation.query, createViewOptions)
				)
				break
			case 'drop_view':
				statements.push(
					buildDropViewSql(
						operation.name,
						definedOptions({ ifExists: operation.ifExists })
					)
				)
				break
			case 'create_topic':
				statements.push(buildCreateTopicSql(operation.name, operation.options))
				break
			case 'alter_topic':
				statements.push(buildAlterTopicSql(operation.name, operation.actions))
				break
			case 'drop_topic':
				statements.push(buildDropTopicSql(operation.name))
				break
			case 'create_async_replication':
				statements.push(
					buildCreateAsyncReplicationSql(
						operation.name,
						operation.targets,
						operation.options
					)
				)
				break
			case 'alter_async_replication':
				statements.push(buildAlterAsyncReplicationSql(operation.name, operation.options))
				break
			case 'drop_async_replication':
				statements.push(
					buildDropAsyncReplicationSql(
						operation.name,
						definedOptions({
							cascade: operation.cascade,
						})
					)
				)
				break
			case 'create_transfer':
				statements.push(
					buildCreateTransferSql(
						operation.name,
						operation.from,
						operation.to,
						operation.using,
						operation.options
					)
				)
				break
			case 'alter_transfer':
				statements.push(
					buildAlterTransferSql(
						operation.name,
						definedOptions({
							using: operation.using,
							options: operation.options,
						})
					)
				)
				break
			case 'drop_transfer':
				statements.push(buildDropTransferSql(operation.name))
				break
			case 'create_secret':
				statements.push(buildCreateSecretSql(operation.name, operation.value))
				break
			case 'create_user':
				statements.push(buildCreateUserSql(operation.name, operation.options))
				break
			case 'alter_user':
				statements.push(buildAlterUserSql(operation.name, operation.options))
				break
			case 'drop_user':
				statements.push(
					buildDropUserSql(
						operation.names,
						definedOptions({ ifExists: operation.ifExists })
					)
				)
				break
			case 'create_group':
				statements.push(
					buildCreateGroupSql(operation.name, definedOptions({ users: operation.users }))
				)
				break
			case 'alter_group':
				statements.push(
					buildAlterGroupSql(operation.name, operation.action, operation.users)
				)
				break
			case 'drop_group':
				statements.push(
					buildDropGroupSql(
						operation.names,
						definedOptions({ ifExists: operation.ifExists })
					)
				)
				break
			case 'grant':
				statements.push(
					buildGrantSql({
						permissions: operation.permissions,
						on: operation.on,
						to: operation.to,
						...definedOptions({ withGrantOption: operation.withGrantOption }),
					})
				)
				break
			case 'revoke':
				statements.push(
					buildRevokeSql({
						permissions: operation.permissions,
						on: operation.on,
						from: operation.from,
						...definedOptions({ grantOptionFor: operation.grantOptionFor }),
					})
				)
				break
			case 'show_create':
				statements.push(buildShowCreateSql(operation.objectType, operation.name))
				break
			case 'add_columns':
				statements.push(...buildAddColumnsSql(operation.table, operation.columns))
				break
			case 'drop_columns':
				statements.push(...buildDropColumnsSql(operation.table, operation.columns))
				break
			case 'add_index':
				statements.push(buildAddIndexSql(operation.table, operation.index))
				break
			case 'drop_index':
				statements.push(buildDropIndexSql(operation.table, operation.name))
				break
			case 'set_table_options':
				statements.push(buildAlterTableSetOptionsSql(operation.table, operation.options))
				break
			case 'reset_table_options':
				statements.push(buildAlterTableResetOptionsSql(operation.table, operation.names))
				break
			case 'add_column_family':
				statements.push(buildAddColumnFamilySql(operation.table, operation.family))
				break
			case 'alter_column_family':
				statements.push(
					buildAlterColumnFamilySql(operation.table, operation.name, operation.options)
				)
				break
			case 'set_column_family':
				statements.push(
					...buildAlterColumnSetFamilySql(
						operation.table,
						operation.columns,
						operation.familyName
					)
				)
				break
			case 'rename_table':
				statements.push(buildRenameTableSql(operation.table, operation.to))
				break
			case 'add_changefeed':
				statements.push(
					buildAddChangefeedSql(operation.table, operation.name, operation.options)
				)
				break
			case 'drop_changefeed':
				statements.push(buildDropChangefeedSql(operation.table, operation.name))
				break
			case 'alter_table':
				statements.push(buildAlterTableSql(operation.table, operation.actions))
				break
		}
	}

	return statements
}

export function normalizeInlineMigration(
	migration: YdbInlineMigration,
	index: number
): YdbNormalizedMigration {
	const sqlStatements = migration.sql
		? [...migration.sql]
		: migration.operations
			? buildMigrationSql(migration.operations)
			: []

	if (sqlStatements.length === 0) {
		throw new Error(`YDB migrate() received migration #${index + 1} without sql or operations`)
	}

	const text = sqlStatements.join('\n--> statement-breakpoint\n')
	const hash = migration.hash ?? crypto.createHash('sha256').update(text).digest('hex')

	return {
		name: buildStableMigrationName(
			{ name: migration.name, folderMillis: migration.folderMillis, hash },
			'inline'
		),
		folderMillis: migration.folderMillis ?? index + 1,
		hash,
		bps: migration.breakpoints ?? false,
		sql: sqlStatements,
	}
}

export function buildMigrationHistorySelectSql(config: YdbMigrationTableConfig = {}): string {
	const migrationTableName = getMigrationTableName(config)

	return [
		`SELECT ${escapeName('hash')}, ${escapeName('created_at')}, ${escapeName('name')}, ${escapeName('status')},`,
		`${escapeName('started_at')}, ${escapeName('finished_at')}, ${escapeName('error')}, ${escapeName('owner_id')},`,
		`${escapeName('statements_total')}, ${escapeName('statements_applied')}`,
		`FROM ${escapeName(migrationTableName)}`,
		`ORDER BY ${escapeName('created_at')} DESC`,
	].join(' ')
}

function renderNullableString(value: string | undefined): string {
	return value === undefined ? 'NULL' : escapeString(value)
}

function renderNullableNumber(value: number | undefined): string {
	return value === undefined ? 'NULL' : String(value)
}

export function buildMigrationHistoryInsertSql(
	migration:
		| Pick<YdbNormalizedMigration, 'hash' | 'folderMillis' | 'name'>
		| YdbMigrationHistoryRecord,
	config: YdbMigrationTableConfig = {}
): string {
	const migrationTableName = getMigrationTableName(config)
	const record: YdbMigrationHistoryRecord =
		'status' in migration
			? migration
			: {
					hash: migration.hash,
					folderMillis: migration.folderMillis,
					name: migration.name,
					status: 'applied',
				}

	return [
		`UPSERT INTO ${escapeName(migrationTableName)} (`,
		[
			escapeName('hash'),
			escapeName('created_at'),
			escapeName('name'),
			escapeName('status'),
			escapeName('started_at'),
			escapeName('finished_at'),
			escapeName('error'),
			escapeName('owner_id'),
			escapeName('statements_total'),
			escapeName('statements_applied'),
		].join(', '),
		`) VALUES (`,
		[
			escapeString(record.hash),
			String(record.folderMillis),
			escapeString(record.name),
			escapeString(record.status),
			renderNullableNumber(record.startedAt),
			renderNullableNumber(record.finishedAt),
			renderNullableString(record.error),
			renderNullableString(record.ownerId),
			renderNullableNumber(record.statementsTotal),
			renderNullableNumber(record.statementsApplied),
		].join(', '),
		`)`,
	].join(' ')
}

export function buildMigrationLockSelectSql(
	config: YdbMigrationTableConfig = {},
	key = 'migrate'
): string {
	const lockTableName = getMigrationLockTableName(config)

	return [
		`SELECT ${escapeName('owner_id')}, ${escapeName('expires_at')}`,
		`FROM ${escapeName(lockTableName)}`,
		`WHERE ${escapeName('lock_key')} = ${escapeString(key)}`,
	].join(' ')
}

export function buildMigrationLockUpsertSql(
	config: YdbMigrationTableConfig = {},
	lock: {
		key: string
		ownerId: string
		acquiredAt: number
		heartbeatAt: number
		expiresAt: number
	}
): string {
	const lockTableName = getMigrationLockTableName(config)

	return [
		`UPSERT INTO ${escapeName(lockTableName)} (`,
		[
			escapeName('lock_key'),
			escapeName('owner_id'),
			escapeName('acquired_at'),
			escapeName('heartbeat_at'),
			escapeName('expires_at'),
		].join(', '),
		`) VALUES (`,
		[
			escapeString(lock.key),
			escapeString(lock.ownerId),
			String(lock.acquiredAt),
			String(lock.heartbeatAt),
			String(lock.expiresAt),
		].join(', '),
		`)`,
	].join(' ')
}

export function buildMigrationLockRefreshSql(
	config: YdbMigrationTableConfig = {},
	lock: {
		key: string
		ownerId: string
		heartbeatAt: number
		expiresAt: number
	}
): string {
	const lockTableName = getMigrationLockTableName(config)

	return [
		`UPDATE ${escapeName(lockTableName)}`,
		`SET ${escapeName('heartbeat_at')} = ${String(lock.heartbeatAt)}, ${escapeName('expires_at')} = ${String(lock.expiresAt)}`,
		`WHERE ${escapeName('lock_key')} = ${escapeString(lock.key)} AND ${escapeName('owner_id')} = ${escapeString(lock.ownerId)}`,
	].join(' ')
}

export function buildMigrationLockReleaseSql(
	config: YdbMigrationTableConfig = {},
	lock: { key: string; ownerId: string }
): string {
	const lockTableName = getMigrationLockTableName(config)

	return [
		`DELETE FROM ${escapeName(lockTableName)}`,
		`WHERE ${escapeName('lock_key')} = ${escapeString(lock.key)} AND ${escapeName('owner_id')} = ${escapeString(lock.ownerId)}`,
	].join(' ')
}
