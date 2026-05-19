import {
	type MigrationConfig as DrizzleMigrationConfig,
	type MigrationMeta,
	readMigrationFiles,
} from 'drizzle-orm/migrator'
import type { YdbDatabase } from '../ydb-core/db.js'
import { YdbDialect } from './dialect.js'
import {
	type YdbInlineMigration,
	type YdbMigrationTableConfig,
	type YdbNormalizedMigration,
	buildStableMigrationName,
	normalizeInlineMigration,
} from './migration-ddl.js'

export interface YdbMigratorConfig extends YdbMigrationTableConfig {
	migrations: readonly YdbInlineMigration[]
}

export type YdbMigrateConfig =
	| (DrizzleMigrationConfig & YdbMigrationTableConfig)
	| YdbMigratorConfig

function isDrizzleMigrationConfig(config: YdbMigrateConfig): config is DrizzleMigrationConfig {
	return 'migrationsFolder' in config
}

function normalizeFolderMigrations(config: DrizzleMigrationConfig): YdbNormalizedMigration[] {
	return readMigrationFiles(config).map((migration: MigrationMeta) => ({
		name: buildStableMigrationName(migration, 'folder'),
		folderMillis: migration.folderMillis,
		hash: migration.hash,
		bps: migration.bps,
		sql: migration.sql.filter((statement) => statement.trim() !== ''),
	}))
}

function normalizeMigrations(config: YdbMigrateConfig): YdbNormalizedMigration[] {
	if (isDrizzleMigrationConfig(config)) {
		return normalizeFolderMigrations(config)
	}

	return config.migrations.map((migration, index) => normalizeInlineMigration(migration, index))
}

function getMigrationTableConfig(config: YdbMigrateConfig): YdbMigrationTableConfig {
	const migrationConfig: YdbMigrationTableConfig = {}

	if (config.migrationsTable !== undefined) {
		migrationConfig.migrationsTable = config.migrationsTable
	}
	if (config.migrationsSchema !== undefined) {
		migrationConfig.migrationsSchema = config.migrationsSchema
	}
	if (config.migrationsLockTable !== undefined) {
		migrationConfig.migrationsLockTable = config.migrationsLockTable
	}
	if (config.migrationLock !== undefined) {
		migrationConfig.migrationLock = config.migrationLock
	}
	if (config.migrationRecovery !== undefined) {
		migrationConfig.migrationRecovery = config.migrationRecovery
	}

	return migrationConfig
}

export async function migrate<TSchema extends Record<string, unknown>>(
	db: YdbDatabase<TSchema, any>,
	config: YdbMigrateConfig
): Promise<void> {
	const session = db._.session
	const migrationConfig = getMigrationTableConfig(config)

	const dialect = new YdbDialect()
	await dialect.migrate(normalizeMigrations(config), session, migrationConfig)
}
