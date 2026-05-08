import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql as yql } from 'drizzle-orm'
import {
	type YdbInlineMigration,
	buildCreateTableSql,
	buildMigrationLockTableBootstrapSql,
	index,
	integer,
	migrate,
	text,
	ydbTable,
} from '../../src/index.ts'
import { createLiveContext } from './helpers/context.ts'

let live = createLiveContext()

function normalize(
	rows: Array<[number, string, number | null]>
): Array<[number, string, number | null]> {
	return [...rows].sort((left, right) => left[0] - right[0])
}

test('inline migrate applies DDL, bookkeeping and remains idempotent on live YDB', async (t) => {
	if (!live.requireLiveYdb(t)) return
	live.describeDbChange(
		t,
		'bootstrap migration history table, create a temp table via migrate(), add a column and index via later migrations, verify idempotency, then drop temp objects'
	)

	let suffix = live.baseIntId + 501
	let tableName = `migration_users_${suffix}`
	let migrationTableName = `migration_history_${suffix}`

	let baseUsers = ydbTable(
		tableName,
		{
			id: integer('id').notNull().primaryKey(),
			name: text('name'),
		},
		(table) => [index(`${tableName}_name_idx`).on(table.name)]
	)

	let usersWithAge = ydbTable(
		tableName,
		{
			id: integer('id').notNull().primaryKey(),
			name: text('name'),
			age: integer('age'),
		},
		(table) => [
			index(`${tableName}_name_idx`).on(table.name),
			index(`${tableName}_age_idx`).on(table.age),
		]
	)

	await live.db.execute(yql.raw(`DROP TABLE IF EXISTS \`${migrationTableName}\``))
	await live.db.execute(yql.raw(`DROP TABLE IF EXISTS \`${tableName}\``))

	try {
		await migrate(live.db, {
			migrationsTable: migrationTableName,
			migrations: [
				{
					name: '0001_create_users',
					folderMillis: 1,
					operations: [{ kind: 'create_table', table: baseUsers, ifNotExists: true }],
				},
			],
		})

		await live.db.execute(
			yql.raw(
				`UPSERT INTO \`${tableName}\` (\`id\`, \`name\`) VALUES (1, 'Twilight Sparkle')`
			)
		)
		let initialRows = await live.db.values<[number, string]>(
			yql.raw(`SELECT \`id\`, \`name\` FROM \`${tableName}\` ORDER BY \`id\``)
		)
		assert.deepEqual(initialRows, [[1, 'Twilight Sparkle']])

		let addAgeIndex = index(`${tableName}_age_idx`).on(usersWithAge.age).build(usersWithAge)
		let createUsersMigration: YdbInlineMigration = {
			name: '0001_create_users',
			folderMillis: 1,
			operations: [{ kind: 'create_table', table: baseUsers, ifNotExists: true }],
		}
		let addAgeMigration: YdbInlineMigration = {
			name: '0002_add_age',
			folderMillis: 2,
			operations: [
				{ kind: 'add_columns', table: tableName, columns: [usersWithAge.age] },
				{ kind: 'add_index', table: tableName, index: addAgeIndex },
			],
		}
		let incrementalConfig = {
			migrationsTable: migrationTableName,
			migrations: [createUsersMigration, addAgeMigration],
		}

		await migrate(live.db, incrementalConfig)
		await migrate(live.db, incrementalConfig)

		await live.db.execute(
			yql.raw(
				`UPSERT INTO \`${tableName}\` (\`id\`, \`name\`, \`age\`) VALUES (2, 'Rainbow Dash', 21)`
			)
		)
		let rowsWithAge = await live.db.values<[number, string, number | null]>(
			yql.raw(`SELECT \`id\`, \`name\`, \`age\` FROM \`${tableName}\` ORDER BY \`id\``)
		)
		assert.deepEqual(normalize(rowsWithAge), [
			[1, 'Twilight Sparkle', null],
			[2, 'Rainbow Dash', 21],
		])

		let bookkeepingRows = await live.db.values<[string, number, string]>(
			yql.raw(
				`SELECT \`hash\`, \`created_at\`, \`name\` FROM \`${migrationTableName}\` ORDER BY \`created_at\``
			)
		)
		assert.equal(bookkeepingRows.length, 2)

		let dropAgeIndexMigration: YdbInlineMigration = {
			name: '0003_drop_age_index',
			folderMillis: 3,
			operations: [{ kind: 'drop_index', table: tableName, name: `${tableName}_age_idx` }],
		}
		let dropUsersMigration: YdbInlineMigration = {
			name: '0004_drop_users',
			folderMillis: 4,
			operations: [{ kind: 'drop_table', table: tableName, ifExists: true }],
		}

		await migrate(live.db, {
			migrationsTable: migrationTableName,
			migrations: [
				...incrementalConfig.migrations,
				dropAgeIndexMigration,
				dropUsersMigration,
			],
		})

		await assert.rejects(async () => live.db.values(yql.raw(`SELECT * FROM \`${tableName}\``)))
	} finally {
		await live.db.execute(yql.raw(`DROP TABLE IF EXISTS \`${tableName}\``))
		await live.db.execute(yql.raw(`DROP TABLE IF EXISTS \`${migrationTableName}\``))
	}
})

test('folder migrate accepts drizzle journal/sql format on live YDB', async (t) => {
	if (!live.requireLiveYdb(t)) return
	live.describeDbChange(
		t,
		'create a temp migration folder in drizzle journal format, run migrate() against it, verify created schema and bookkeeping rows, then clean all temp objects'
	)

	let suffix = live.baseIntId + 601
	let tableName = `folder_users_${suffix}`
	let migrationTableName = `folder_history_${suffix}`
	let tempDir = mkdtempSync(join(tmpdir(), 'ydb-migrator-'))
	let metaDir = join(tempDir, 'meta')

	mkdirSync(metaDir, { recursive: true })
	writeFileSync(
		join(metaDir, '_journal.json'),
		JSON.stringify(
			{
				entries: [
					{ idx: 0, when: 1, tag: '0000_create_folder_users', breakpoints: true },
					{ idx: 1, when: 2, tag: '0001_add_age_to_folder_users', breakpoints: true },
				],
			},
			null,
			2
		)
	)
	writeFileSync(
		join(tempDir, '0000_create_folder_users.sql'),
		[
			`CREATE TABLE \`${tableName}\` (`,
			'  `id` Int32 NOT NULL,',
			'  `name` Utf8,',
			'  PRIMARY KEY (`id`)',
			')',
		].join('\n')
	)
	writeFileSync(
		join(tempDir, '0001_add_age_to_folder_users.sql'),
		`ALTER TABLE \`${tableName}\` ADD COLUMN \`age\` Int32`
	)

	await live.db.execute(yql.raw(`DROP TABLE IF EXISTS \`${migrationTableName}\``))
	await live.db.execute(yql.raw(`DROP TABLE IF EXISTS \`${tableName}\``))

	try {
		await migrate(live.db, {
			migrationsFolder: tempDir,
			migrationsTable: migrationTableName,
		})

		await live.db.execute(
			yql.raw(
				`UPSERT INTO \`${tableName}\` (\`id\`, \`name\`, \`age\`) VALUES (1, 'Applejack', 24)`
			)
		)
		let rows = await live.db.values<[number, string, number]>(
			yql.raw(`SELECT \`id\`, \`name\`, \`age\` FROM \`${tableName}\``)
		)
		assert.deepEqual(rows, [[1, 'Applejack', 24]])

		let bookkeepingRows = await live.db.values<[string, number, string]>(
			yql.raw(
				`SELECT \`hash\`, \`created_at\`, \`name\` FROM \`${migrationTableName}\` ORDER BY \`created_at\``
			)
		)
		assert.equal(bookkeepingRows.length, 2)

		await migrate(live.db, {
			migrationsFolder: tempDir,
			migrationsTable: migrationTableName,
		})
		let bookkeepingRowsAfter = await live.db.values<[string, number, string]>(
			yql.raw(
				`SELECT \`hash\`, \`created_at\`, \`name\` FROM \`${migrationTableName}\` ORDER BY \`created_at\``
			)
		)
		assert.equal(bookkeepingRowsAfter.length, 2)
	} finally {
		rmSync(tempDir, { recursive: true, force: true })
		await live.db.execute(yql.raw(`DROP TABLE IF EXISTS \`${tableName}\``))
		await live.db.execute(yql.raw(`DROP TABLE IF EXISTS \`${migrationTableName}\``))
	}
})

test('migration lock and failed-state recovery guard work on live YDB', async (t) => {
	if (!live.requireLiveYdb(t)) return
	live.describeDbChange(
		t,
		'create a live migration lock row and verify a concurrent migration times out, then record a failed migration and verify reruns are blocked until explicit recovery'
	)

	let suffix = live.baseIntId + 651
	let lockHistoryTable = `lock_history_${suffix}`
	let lockTable = `${lockHistoryTable}_lock`
	let failedTable = `failed_migration_${suffix}`
	let failedHistoryTable = `failed_history_${suffix}`
	let failedLockTable = `${failedHistoryTable}_lock`
	let missingTable = `missing_recovery_source_${suffix}`
	let failedHash = `failed_hash_${suffix}`

	await live.db.execute(yql.raw(`DROP TABLE IF EXISTS \`${failedTable}\``))
	await live.db.execute(yql.raw(`DROP TABLE IF EXISTS \`${lockHistoryTable}\``))
	await live.db.execute(yql.raw(`DROP TABLE IF EXISTS \`${lockTable}\``))
	await live.db.execute(yql.raw(`DROP TABLE IF EXISTS \`${failedHistoryTable}\``))
	await live.db.execute(yql.raw(`DROP TABLE IF EXISTS \`${failedLockTable}\``))

	try {
		await live.db.execute(
			yql.raw(buildMigrationLockTableBootstrapSql({ migrationsTable: lockHistoryTable }))
		)
		await live.db.execute(
			yql.raw(
				[
					`UPSERT INTO \`${lockTable}\` (\`lock_key\`, \`owner_id\`, \`acquired_at\`, \`heartbeat_at\`, \`expires_at\`)`,
					`VALUES ('migrate', 'other-runner', 1, 1, ${Date.now() + 60_000})`,
				].join(' ')
			)
		)

		await assert.rejects(
			() =>
				migrate(live.db, {
					migrationsTable: lockHistoryTable,
					migrationLock: {
						ownerId: 'blocked-live-runner',
						acquireTimeoutMs: 50,
						retryIntervalMs: 10,
					},
					migrations: [
						{
							name: '0001_blocked',
							folderMillis: 1,
							sql: [
								`CREATE TABLE \`${failedTable}\` (\`id\` Int32 NOT NULL, PRIMARY KEY (\`id\`))`,
							],
						},
					],
				}),
			/could not acquire migration lock/u
		)

		await live.db.execute(
			yql.raw(`DELETE FROM \`${lockTable}\` WHERE \`lock_key\` = 'migrate'`)
		)

		let failingMigration: YdbInlineMigration = {
			name: '0001_failed',
			folderMillis: 1,
			hash: failedHash,
			sql: [
				`CREATE TABLE IF NOT EXISTS \`${failedTable}\` (\`id\` Int32 NOT NULL, PRIMARY KEY (\`id\`))`,
				`SELECT * FROM \`${missingTable}\``,
			],
		}

		await assert.rejects(
			() =>
				migrate(live.db, {
					migrationsTable: failedHistoryTable,
					migrationLock: { ownerId: 'failed-live-runner' },
					migrations: [failingMigration],
				}),
			/failed after 1\/2 statements/u
		)

		let failedRows = await live.db.values<
			[string, string | null, number | null, number | null]
		>(
			yql.raw(
				`SELECT \`status\`, \`error\`, \`statements_total\`, \`statements_applied\` FROM \`${failedHistoryTable}\` WHERE \`hash\` = '${failedHash}'`
			)
		)
		assert.equal(failedRows.length, 1)
		assert.equal(failedRows[0]![0], 'failed')
		assert.equal(failedRows[0]![2], 2)
		assert.equal(failedRows[0]![3], 1)
		assert.notEqual(failedRows[0]![1], null)

		await assert.rejects(
			() =>
				migrate(live.db, {
					migrationsTable: failedHistoryTable,
					migrationLock: { ownerId: 'blocked-after-failed-live-runner' },
					migrations: [failingMigration],
				}),
			/marked as failed/u
		)
	} finally {
		await live.db.execute(yql.raw(`DROP TABLE IF EXISTS \`${failedTable}\``))
		await live.db.execute(yql.raw(`DROP TABLE IF EXISTS \`${lockHistoryTable}\``))
		await live.db.execute(yql.raw(`DROP TABLE IF EXISTS \`${lockTable}\``))
		await live.db.execute(yql.raw(`DROP TABLE IF EXISTS \`${failedHistoryTable}\``))
		await live.db.execute(yql.raw(`DROP TABLE IF EXISTS \`${failedLockTable}\``))
	}
})

test('inline unique column constraints work on live YDB', async (t) => {
	if (!live.requireLiveYdb(t)) return
	live.describeDbChange(
		t,
		'create a temp table with inline unique() metadata, verify duplicate values are rejected by YDB, then drop the temp table'
	)

	let suffix = live.baseIntId + 701
	let tableName = `unique_users_${suffix}`
	let users = ydbTable(tableName, {
		id: integer('id').notNull().primaryKey(),
		email: text('email').notNull().unique(),
	})

	await live.db.execute(yql.raw(`DROP TABLE IF EXISTS \`${tableName}\``))

	try {
		await live.db.execute(yql.raw(buildCreateTableSql(users, { ifNotExists: true })))
		await live.db.execute(
			yql.raw(
				`INSERT INTO \`${tableName}\` (\`id\`, \`email\`) VALUES (1, 'rarity@example.com')`
			)
		)

		await assert.rejects(() =>
			live.db.execute(
				yql.raw(
					`INSERT INTO \`${tableName}\` (\`id\`, \`email\`) VALUES (2, 'rarity@example.com')`
				)
			)
		)

		let rows = await live.db.values<[number, string]>(
			yql.raw(`SELECT \`id\`, \`email\` FROM \`${tableName}\` ORDER BY \`id\``)
		)
		assert.deepEqual(rows, [[1, 'rarity@example.com']])
	} finally {
		await live.db.execute(yql.raw(`DROP TABLE IF EXISTS \`${tableName}\``))
	}
})
