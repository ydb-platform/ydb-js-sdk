import { test } from 'vitest'
import assert from 'node:assert/strict'
import {
	buildAddChangefeedSql,
	buildAddColumnFamilySql,
	buildAddColumnsSql,
	buildAddIndexSql,
	buildAlterAsyncReplicationSql,
	buildAlterColumnFamilySql,
	buildAlterColumnSetFamilySql,
	buildAlterGroupSql,
	buildAlterTableResetOptionsSql,
	buildAlterTableSetOptionsSql,
	buildAlterTableSql,
	buildAlterTopicSql,
	buildAlterTransferSql,
	buildAlterUserSql,
	buildAnalyzeSql,
	buildCreateAsyncReplicationSql,
	buildCreateGroupSql,
	buildCreateSecretSql,
	buildCreateTableSql,
	buildCreateTopicSql,
	buildCreateTransferSql,
	buildCreateUserSql,
	buildCreateViewSql,
	buildDropAsyncReplicationSql,
	buildDropChangefeedSql,
	buildDropColumnsSql,
	buildDropGroupSql,
	buildDropIndexSql,
	buildDropTableSql,
	buildDropTopicSql,
	buildDropTransferSql,
	buildDropUserSql,
	buildDropViewSql,
	buildGrantSql,
	buildMigrationSql,
	buildRenameTableSql,
	buildRevokeSql,
	buildShowCreateSql,
	bytes,
	columnFamily,
	index,
	integer,
	partitionByHash,
	rawTableOption,
	tableOptions,
	text,
	ttl,
	uint32,
	unique,
	vectorIndex,
	ydbTable,
} from '../../src/index.ts'

test('migration DDL generates create table with inline indexes and unique constraints', () => {
	let users = ydbTable(
		'migration_users',
		{
			id: integer('id').notNull().primaryKey(),
			name: text('name').notNull(),
			age: integer('age'),
		},
		(table) => [
			index('migration_users_name_idx').on(table.name).cover(table.age),
			unique('migration_users_name_unique').on(table.name),
		]
	)

	let ddl = buildCreateTableSql(users, { ifNotExists: true })

	assert.match(ddl, /^CREATE TABLE IF NOT EXISTS `migration_users`/u)
	assert.match(ddl, /`id` Int32 NOT NULL/u)
	assert.match(ddl, /`name` Utf8 NOT NULL/u)
	assert.match(ddl, /INDEX `migration_users_name_idx` GLOBAL SYNC ON \(`name`\) COVER \(`age`\)/u)
	assert.match(ddl, /INDEX `migration_users_name_unique` GLOBAL UNIQUE SYNC ON \(`name`\)/u)
	assert.match(ddl, /PRIMARY KEY \(`id`\)/u)
})

test('migration DDL generates table options, partitioning, TTL, and column families', () => {
	let events = ydbTable(
		'migration_events',
		{
			id: integer('id').notNull().primaryKey(),
			payload: text('payload').notNull(),
			expiresAt: uint32('expires_at').notNull(),
		},
		(table) => [
			columnFamily('cold', { data: 'rot', compression: 'lz4' }).columns(table.payload),
			partitionByHash(table.id),
			ttl(table.expiresAt, 'P7D', { unit: 'SECONDS' }),
			tableOptions({
				STORE: 'COLUMN',
				AUTO_PARTITIONING_BY_SIZE: 'ENABLED',
				AUTO_PARTITIONING_PARTITION_SIZE_MB: 512,
			}),
		]
	)

	let ddl = buildCreateTableSql(events)

	assert.match(ddl, /^CREATE TABLE `migration_events`/u)
	assert.match(ddl, /`payload` Utf8 FAMILY `cold` NOT NULL/u)
	assert.match(ddl, /FAMILY `cold` \(DATA = "rot", COMPRESSION = "lz4"\)/u)
	assert.match(ddl, /PARTITION BY HASH\(`id`\)/u)
	assert.match(ddl, /STORE = COLUMN/u)
	assert.match(ddl, /AUTO_PARTITIONING_BY_SIZE = ENABLED/u)
	assert.match(ddl, /AUTO_PARTITIONING_PARTITION_SIZE_MB = 512/u)
	assert.match(ddl, /TTL = Interval\("P7D"\) ON `expires_at` AS SECONDS/u)
})

test('migration DDL generates vector k-means tree indexes', () => {
	let articles = ydbTable(
		'user_articles',
		{
			articleId: uint32('article_id').notNull().primaryKey(),
			user: text('user').notNull(),
			title: text('title'),
			body: text('body'),
			embedding: bytes('embedding').notNull(),
		},
		(table) => [
			vectorIndex('emb_cosine_idx', {
				distance: 'cosine',
				vectorType: 'float',
				vectorDimension: 512,
				clusters: 128,
				levels: 2,
			})
				.on(table.user, table.embedding)
				.cover(table.title, table.body),
		]
	)

	let ddl = buildCreateTableSql(articles)
	let similarityIndex = vectorIndex({
		similarity: 'inner_product',
		vectorType: 'uint8',
		vectorDimension: 256,
		clusters: 64,
		levels: 2,
	})
		.on(articles.embedding)
		.build(articles)
	let methodIndex = index('emb_euclidean_idx')
		.on(articles.embedding)
		.vectorKMeansTree({
			distance: 'euclidean',
			vectorType: 'int8',
			vectorDimension: 128,
			clusters: 32,
			levels: 2,
		})
		.build(articles)

	assert.match(
		ddl,
		/INDEX `emb_cosine_idx` GLOBAL SYNC USING vector_kmeans_tree ON \(`user`, `embedding`\) COVER \(`title`, `body`\) WITH \(distance = 'cosine', vector_type = 'float', vector_dimension = 512, clusters = 128, levels = 2\)/u
	)
	assert.equal(
		buildAddIndexSql(articles, similarityIndex),
		"ALTER TABLE `user_articles` ADD INDEX `user_articles_embedding_idx` GLOBAL SYNC USING vector_kmeans_tree ON (`embedding`) WITH (similarity = 'inner_product', vector_type = 'uint8', vector_dimension = 256, clusters = 64, levels = 2)"
	)
	assert.equal(
		buildAddIndexSql(articles, methodIndex),
		"ALTER TABLE `user_articles` ADD INDEX `emb_euclidean_idx` GLOBAL SYNC USING vector_kmeans_tree ON (`embedding`) WITH (distance = 'euclidean', vector_type = 'int8', vector_dimension = 128, clusters = 32, levels = 2)"
	)
})

test('migration DDL generates ALTER statements for table options and column families', () => {
	let events = ydbTable('migration_events', {
		id: integer('id').notNull().primaryKey(),
		payload: text('payload').notNull(),
		body: text('body'),
	})

	assert.equal(
		buildAlterTableSetOptionsSql(events, {
			STORE: 'ROW',
			AUTO_PARTITIONING_BY_SIZE: 'DISABLED',
			READ_REPLICAS_SETTINGS: rawTableOption("'PER_AZ: 2'"),
		}),
		"ALTER TABLE `migration_events` SET (STORE = ROW, AUTO_PARTITIONING_BY_SIZE = DISABLED, READ_REPLICAS_SETTINGS = 'PER_AZ: 2')"
	)
	assert.equal(
		buildAlterTableResetOptionsSql(events, ['TTL', 'AUTO_PARTITIONING_BY_SIZE']),
		'ALTER TABLE `migration_events` RESET (TTL, AUTO_PARTITIONING_BY_SIZE)'
	)
	assert.equal(
		buildAddColumnFamilySql(events, {
			name: 'hot',
			options: { data: 'ssd', compression: 'lz4' },
		}),
		'ALTER TABLE `migration_events` ADD FAMILY `hot` (DATA = "ssd", COMPRESSION = "lz4")'
	)
	assert.equal(
		buildAlterColumnFamilySql(events, 'hot', {
			data: 'rot',
			compression: 'zstd',
			compressionLevel: 4,
		}),
		'ALTER TABLE `migration_events` ALTER FAMILY `hot` SET DATA "rot", ALTER FAMILY `hot` SET COMPRESSION "zstd", ALTER FAMILY `hot` SET COMPRESSION_LEVEL 4'
	)
	assert.deepEqual(buildAlterColumnSetFamilySql(events, [events.payload, events.body], 'hot'), [
		'ALTER TABLE `migration_events` ALTER COLUMN `payload` SET FAMILY `hot`',
		'ALTER TABLE `migration_events` ALTER COLUMN `body` SET FAMILY `hot`',
	])
	assert.deepEqual(
		buildMigrationSql([
			{ kind: 'set_table_options', table: events, options: { STORE: 'ROW' } },
			{ kind: 'reset_table_options', table: events, names: ['TTL'] },
			{
				kind: 'add_column_family',
				table: events,
				family: { name: 'cold', options: { data: 'rot' } },
			},
			{
				kind: 'alter_column_family',
				table: events,
				name: 'cold',
				options: { compression: 'lz4' },
			},
			{
				kind: 'set_column_family',
				table: events,
				columns: ['body'],
				familyName: 'cold',
			},
		]),
		[
			'ALTER TABLE `migration_events` SET (STORE = ROW)',
			'ALTER TABLE `migration_events` RESET (TTL)',
			'ALTER TABLE `migration_events` ADD FAMILY `cold` (DATA = "rot")',
			'ALTER TABLE `migration_events` ALTER FAMILY `cold` SET COMPRESSION "lz4"',
			'ALTER TABLE `migration_events` ALTER COLUMN `body` SET FAMILY `cold`',
		]
	)
})

test('migration DDL generates alter and drop statements', () => {
	let users = ydbTable('migration_users', {
		id: integer('id').notNull().primaryKey(),
		age: integer('age'),
		score: integer('score').notNull(),
	})
	let ageIndex = index('migration_users_age_idx').on(users.age).build(users)

	assert.deepEqual(buildAddColumnsSql(users, [users.age, users.score]), [
		'ALTER TABLE `migration_users` ADD COLUMN `age` Int32',
		'ALTER TABLE `migration_users` ADD COLUMN `score` Int32 NOT NULL',
	])
	assert.deepEqual(buildDropColumnsSql(users, ['age', 'score']), [
		'ALTER TABLE `migration_users` DROP COLUMN `age`',
		'ALTER TABLE `migration_users` DROP COLUMN `score`',
	])
	assert.equal(
		buildAddIndexSql(users, ageIndex),
		'ALTER TABLE `migration_users` ADD INDEX `migration_users_age_idx` GLOBAL SYNC ON (`age`)'
	)
	assert.equal(
		buildDropIndexSql(users, 'migration_users_age_idx'),
		'ALTER TABLE `migration_users` DROP INDEX `migration_users_age_idx`'
	)
	assert.equal(
		buildDropTableSql(users, { ifExists: true }),
		'DROP TABLE IF EXISTS `migration_users`'
	)
	assert.deepEqual(
		buildMigrationSql([
			{ kind: 'add_columns', table: users, columns: [users.age] },
			{ kind: 'add_index', table: users, index: ageIndex },
			{ kind: 'drop_columns', table: users, columns: ['age'] },
		]),
		[
			'ALTER TABLE `migration_users` ADD COLUMN `age` Int32',
			'ALTER TABLE `migration_users` ADD INDEX `migration_users_age_idx` GLOBAL SYNC ON (`age`)',
			'ALTER TABLE `migration_users` DROP COLUMN `age`',
		]
	)
})

test('migration DDL generates ANALYZE, VIEW, TOPIC, CHANGEFEED, rename, and multi-action ALTER TABLE', () => {
	let users = ydbTable('migration_admin_users', {
		id: integer('id').notNull().primaryKey(),
		age: integer('age'),
		name: text('name'),
		status: text('status'),
	})
	let ageIndex = index('migration_admin_users_age_idx').on(users.age).build(users)

	assert.equal(buildAnalyzeSql(users), 'ANALYZE `migration_admin_users`')
	assert.equal(
		buildAnalyzeSql(users, [users.age, 'status']),
		'ANALYZE `migration_admin_users` (`age`, `status`)'
	)
	assert.equal(
		buildCreateViewSql(
			'migration_admin_view',
			'SELECT `id`, `name` FROM `migration_admin_users`',
			{
				ifNotExists: true,
			}
		),
		'CREATE VIEW IF NOT EXISTS `migration_admin_view` WITH (security_invoker = TRUE) AS SELECT `id`, `name` FROM `migration_admin_users`'
	)
	assert.equal(
		buildDropViewSql('migration_admin_view', { ifExists: true }),
		'DROP VIEW IF EXISTS `migration_admin_view`'
	)
	assert.equal(
		buildCreateTopicSql('migration_admin_topic', {
			consumers: [
				{
					name: 'events',
					settings: {
						important: true,
						read_from: rawTableOption("Timestamp('2024-01-01T00:00:00Z')"),
					},
				},
			],
			settings: { retention_period: rawTableOption("Interval('P1D')") },
		}),
		[
			'CREATE TOPIC `migration_admin_topic` (',
			"  CONSUMER `events` WITH (important = TRUE, read_from = Timestamp('2024-01-01T00:00:00Z'))",
			') WITH (',
			"  retention_period = Interval('P1D')",
			')',
		].join('\n')
	)
	assert.equal(
		buildAlterTopicSql('migration_admin_topic', [
			{ kind: 'add_consumer', consumer: { name: 'audit' } },
			{
				kind: 'alter_consumer_set',
				name: 'audit',
				settings: { important: false },
			},
			{ kind: 'drop_consumer', name: 'old_audit' },
		]),
		'ALTER TOPIC `migration_admin_topic` ADD CONSUMER `audit`, ALTER CONSUMER `audit` SET (important = FALSE), DROP CONSUMER `old_audit`'
	)
	assert.equal(buildDropTopicSql('migration_admin_topic'), 'DROP TOPIC `migration_admin_topic`')
	assert.equal(
		buildAddChangefeedSql(users, 'updates_feed', {
			mode: 'NEW_IMAGE',
			format: 'JSON',
			retentionPeriod: 'PT1H',
			virtualTimestamps: true,
		}),
		"ALTER TABLE `migration_admin_users` ADD CHANGEFEED `updates_feed` WITH (MODE = 'NEW_IMAGE', FORMAT = 'JSON', VIRTUAL_TIMESTAMPS = TRUE, RETENTION_PERIOD = Interval('PT1H'))"
	)
	assert.equal(
		buildDropChangefeedSql(users, 'updates_feed'),
		'ALTER TABLE `migration_admin_users` DROP CHANGEFEED `updates_feed`'
	)
	assert.equal(
		buildRenameTableSql('migration_admin_users', 'migration_admin_users_archive'),
		'ALTER TABLE `migration_admin_users` RENAME TO `migration_admin_users_archive`'
	)
	assert.equal(
		buildAlterTableSql(users, [
			{ kind: 'add_column', column: users.status },
			{ kind: 'add_index', index: ageIndex },
			{
				kind: 'add_changefeed',
				name: 'updates_feed',
				options: { mode: 'UPDATES', format: 'JSON' },
			},
			{ kind: 'drop_column', name: 'name' },
		]),
		"ALTER TABLE `migration_admin_users` ADD COLUMN `status` Utf8, ADD INDEX `migration_admin_users_age_idx` GLOBAL SYNC ON (`age`), ADD CHANGEFEED `updates_feed` WITH (MODE = 'UPDATES', FORMAT = 'JSON'), DROP COLUMN `name`"
	)
	assert.deepEqual(
		buildMigrationSql([
			{ kind: 'analyze', table: users, columns: [users.id] },
			{
				kind: 'create_view',
				name: 'migration_admin_view',
				query: 'SELECT 1 AS `id`',
			},
			{ kind: 'drop_view', name: 'migration_admin_view', ifExists: true },
			{ kind: 'create_topic', name: 'migration_admin_topic' },
			{
				kind: 'alter_topic',
				name: 'migration_admin_topic',
				actions: [
					{
						kind: 'set_options',
						settings: { retention_period: rawTableOption("Interval('PT1H')") },
					},
				],
			},
			{ kind: 'drop_topic', name: 'migration_admin_topic' },
			{
				kind: 'rename_table',
				table: 'migration_admin_users',
				to: 'migration_admin_users_archive',
			},
		]),
		[
			'ANALYZE `migration_admin_users` (`id`)',
			'CREATE VIEW `migration_admin_view` WITH (security_invoker = TRUE) AS SELECT 1 AS `id`',
			'DROP VIEW IF EXISTS `migration_admin_view`',
			'CREATE TOPIC `migration_admin_topic`',
			"ALTER TOPIC `migration_admin_topic` SET (retention_period = Interval('PT1H'))",
			'DROP TOPIC `migration_admin_topic`',
			'ALTER TABLE `migration_admin_users` RENAME TO `migration_admin_users_archive`',
		]
	)
})

test('migration DDL generates temporary tables, replication, transfer, secrets, users, groups, grants, and SHOW CREATE', () => {
	let tempTable = ydbTable('migration_temp_events', {
		id: integer('id').notNull().primaryKey(),
		payload: text('payload'),
	})

	assert.match(
		buildCreateTableSql(tempTable, { temporary: true, ifNotExists: true }),
		/^CREATE TEMPORARY TABLE IF NOT EXISTS `migration_temp_events`/u
	)
	assert.equal(
		buildCreateTableSql(tempTable, { temporary: 'temp' }).split('\n')[0],
		'CREATE TEMP TABLE `migration_temp_events` ('
	)
	assert.equal(
		buildCreateAsyncReplicationSql(
			'orders_replication',
			[{ remote: '/Root/source/orders', local: 'orders_replica' }],
			{
				connectionString: 'grpcs://example.com:2135/?database=/Root/source',
				tokenSecretName: 'replication_token',
				consistencyLevel: 'GLOBAL',
				commitInterval: 'PT1M',
			}
		),
		"CREATE ASYNC REPLICATION `orders_replication` FOR `/Root/source/orders` AS `orders_replica` WITH (CONNECTION_STRING = 'grpcs://example.com:2135/?database=/Root/source', TOKEN_SECRET_NAME = 'replication_token', CONSISTENCY_LEVEL = 'GLOBAL', COMMIT_INTERVAL = Interval('PT1M'))"
	)
	assert.equal(
		buildAlterAsyncReplicationSql('orders_replication', {
			state: 'DONE',
			failoverMode: 'FORCE',
		}),
		"ALTER ASYNC REPLICATION `orders_replication` SET (STATE = 'DONE', FAILOVER_MODE = 'FORCE')"
	)
	assert.equal(
		buildDropAsyncReplicationSql('orders_replication', { cascade: true }),
		'DROP ASYNC REPLICATION `orders_replication` CASCADE'
	)
	assert.equal(
		buildCreateTransferSql('orders_transfer', 'orders_topic', 'orders', '$lambda', {
			consumer: 'orders_consumer',
			batchSizeBytes: 1048576,
			flushInterval: 'PT60S',
		}),
		"CREATE TRANSFER `orders_transfer` FROM `orders_topic` TO `orders` USING $lambda WITH (CONSUMER = 'orders_consumer', BATCH_SIZE_BYTES = 1048576, FLUSH_INTERVAL = Interval('PT60S'))"
	)
	assert.equal(
		buildAlterTransferSql('orders_transfer', { using: '$new_lambda' }),
		'ALTER TRANSFER `orders_transfer` SET USING $new_lambda'
	)
	assert.equal(
		buildAlterTransferSql('orders_transfer', {
			options: { state: 'PAUSED', batchSizeBytes: 2048 },
		}),
		"ALTER TRANSFER `orders_transfer` SET (STATE = 'PAUSED', BATCH_SIZE_BYTES = 2048)"
	)
	assert.equal(buildDropTransferSql('orders_transfer'), 'DROP TRANSFER `orders_transfer`')
	assert.equal(
		buildCreateSecretSql('replication_token', 'token"value'),
		'CREATE OBJECT `replication_token` (TYPE SECRET) WITH value="token\\"value"'
	)
	assert.equal(
		buildCreateUserSql('app_user', { password: 'secret', login: true }),
		"CREATE USER `app_user` PASSWORD 'secret' LOGIN"
	)
	assert.equal(
		buildAlterUserSql('app_user', {
			password: null,
			login: false,
			withKeyword: true,
		}),
		'ALTER USER `app_user` WITH PASSWORD NULL NOLOGIN'
	)
	assert.equal(
		buildDropUserSql(['app_user', 'old_user'], { ifExists: true }),
		'DROP USER IF EXISTS `app_user`, `old_user`'
	)
	assert.equal(
		buildCreateGroupSql('app_group', { users: ['app_user', 'audit_user'] }),
		'CREATE GROUP `app_group` WITH USER `app_user`, `audit_user`'
	)
	assert.equal(
		buildAlterGroupSql('app_group', 'add_user', ['new_user']),
		'ALTER GROUP `app_group` ADD USER `new_user`'
	)
	assert.equal(
		buildDropGroupSql(['app_group'], { ifExists: true }),
		'DROP GROUP IF EXISTS `app_group`'
	)
	assert.equal(
		buildGrantSql({
			permissions: ['SELECT ROW', 'ydb.generic.list'],
			on: ['/Root/orders'],
			to: ['app_group'],
			withGrantOption: true,
		}),
		"GRANT SELECT ROW, 'ydb.generic.list' ON `/Root/orders` TO `app_group` WITH GRANT OPTION"
	)
	assert.equal(
		buildRevokeSql({
			permissions: { kind: 'all', privileges: true },
			on: ['/Root/orders'],
			from: ['app_group'],
			grantOptionFor: true,
		}),
		'REVOKE GRANT OPTION FOR ALL PRIVILEGES ON `/Root/orders` FROM `app_group`'
	)
	assert.equal(buildShowCreateSql('table', 'orders'), 'SHOW CREATE TABLE `orders`')
	assert.deepEqual(
		buildMigrationSql([
			{
				kind: 'create_async_replication',
				name: 'orders_replication',
				targets: [{ remote: 'orders', local: 'orders_replica' }],
				options: { connectionString: 'grpc://localhost', tokenSecretName: 't' },
			},
			{
				kind: 'alter_transfer',
				name: 'orders_transfer',
				options: { state: 'ACTIVE' },
			},
			{ kind: 'drop_transfer', name: 'orders_transfer' },
			{ kind: 'create_secret', name: 't', value: 'token' },
			{ kind: 'create_user', name: 'app_user', options: { login: false } },
			{
				kind: 'grant',
				permissions: 'SELECT',
				on: ['/Root/orders'],
				to: ['app_user'],
			},
			{ kind: 'show_create', objectType: 'table', name: 'orders' },
		]),
		[
			"CREATE ASYNC REPLICATION `orders_replication` FOR `orders` AS `orders_replica` WITH (CONNECTION_STRING = 'grpc://localhost', TOKEN_SECRET_NAME = 't')",
			"ALTER TRANSFER `orders_transfer` SET (STATE = 'ACTIVE')",
			'DROP TRANSFER `orders_transfer`',
			'CREATE OBJECT `t` (TYPE SECRET) WITH value="token"',
			'CREATE USER `app_user` NOLOGIN',
			'GRANT SELECT ON `/Root/orders` TO `app_user`',
			'SHOW CREATE TABLE `orders`',
		]
	)
})

test('migration DDL rejects invalid YDB constructs', () => {
	let users = ydbTable('users', {
		id: integer('id').notNull().primaryKey(),
		name: text('name'),
	})
	let uniqueAge = unique('users_age_unique').on(users.name).build(users)

	assert.throws(() => buildAddIndexSql(users, uniqueAge), /cannot add UNIQUE indexes/u)
})

test('migration DDL rejects invalid table option and family definitions', () => {
	let duplicateOptionTable = ydbTable(
		'duplicate_options',
		{
			id: integer('id').notNull().primaryKey(),
		},
		() => [tableOptions({ STORE: 'ROW' }), tableOptions({ STORE: 'COLUMN' })]
	)
	let duplicateTtlTable = ydbTable(
		'duplicate_ttl',
		{
			id: integer('id').notNull().primaryKey(),
			expiresAt: uint32('expires_at').notNull(),
		},
		(table) => [ttl(table.expiresAt, 'P1D'), ttl(table.expiresAt, 'P2D')]
	)
	let duplicateFamilyTable = ydbTable(
		'duplicate_family',
		{
			id: integer('id').notNull().primaryKey(),
			payload: text('payload'),
		},
		(table) => [
			columnFamily('hot').columns(table.payload),
			columnFamily('cold').columns(table.payload),
		]
	)
	let duplicateFamilyNameTable = ydbTable(
		'duplicate_family_name',
		{
			id: integer('id').notNull().primaryKey(),
			payload: text('payload'),
			metadata: text('metadata'),
		},
		(table) => [
			columnFamily('hot').columns(table.payload),
			columnFamily('hot').columns(table.metadata),
		]
	)

	assert.throws(
		() => buildCreateTableSql(duplicateOptionTable),
		/duplicate table option "STORE"/u
	)
	assert.throws(() => buildCreateTableSql(duplicateTtlTable), /supports only one TTL/u)
	assert.throws(
		() => buildCreateTableSql(duplicateFamilyTable),
		/assigned to both "hot" and "cold"/u
	)
	assert.throws(
		() => buildCreateTableSql(duplicateFamilyNameTable),
		/duplicate column family "hot"/u
	)
	assert.throws(
		() => buildAlterTableSetOptionsSql('duplicate_options', {}),
		/requires at least one option/u
	)
	assert.throws(
		() => buildAlterColumnFamilySql('duplicate_family', 'hot', {}),
		/requires at least one option/u
	)
})

test('migration DDL escapes identifiers and rejects unsafe option names', () => {
	let users = ydbTable(
		'users` DROP TABLE audit; --',
		{
			id: integer('id`x').notNull().primaryKey(),
			name: text('name`x'),
		},
		(table) => [
			index('users`name`idx').on(table.name),
			columnFamily('hot`family').columns(table.name),
			tableOptions({ STORE: 'ROW' }),
		]
	)

	let ddl = buildCreateTableSql(users)

	assert.match(ddl, /CREATE TABLE `users`` DROP TABLE audit; --`/u)
	assert.match(ddl, /`id``x` Int32 NOT NULL/u)
	assert.match(ddl, /`name``x` Utf8 FAMILY `hot``family`/u)
	assert.match(ddl, /INDEX `users``name``idx` GLOBAL SYNC ON \(`name``x`\)/u)

	assert.throws(
		() => buildAlterTableSetOptionsSql('safe_table', { 'STORE) DROP TABLE users; --': 'ROW' }),
		/invalid option name/u
	)
	assert.throws(
		() => buildAlterTableResetOptionsSql('safe_table', ['TTL) DROP TABLE users; --']),
		/invalid option name/u
	)
	assert.throws(
		() =>
			buildAddChangefeedSql('safe_table', 'updates', {
				mode: 'UPDATES',
				options: { 'FORMAT) DROP TABLE users; --': 'JSON' },
			}),
		/invalid option name/u
	)
})

test('migration DDL escapes service object identifiers and literal values', () => {
	assert.equal(
		buildDropTableSql('safe` DROP TABLE audit; --', { ifExists: true }),
		'DROP TABLE IF EXISTS `safe`` DROP TABLE audit; --`'
	)
	assert.equal(buildAnalyzeSql('safe`table', ['col`umn']), 'ANALYZE `safe``table` (`col``umn`)')
	assert.equal(
		buildRenameTableSql('safe`table', 'renamed`table'),
		'ALTER TABLE `safe``table` RENAME TO `renamed``table`'
	)
	assert.equal(
		buildCreateSecretSql('secret`name', 'token"\\value'),
		'CREATE OBJECT `secret``name` (TYPE SECRET) WITH value="token\\"\\\\value"'
	)
	assert.equal(
		buildCreateUserSql('user`name', {
			password: "pa'ss",
		}),
		"CREATE USER `user``name` PASSWORD 'pa''ss'"
	)
	assert.equal(
		buildGrantSql({
			permissions: 'SELECT',
			on: ['folder`name/table'],
			to: ['user`name'],
		}),
		'GRANT SELECT ON `folder``name/table` TO `user``name`'
	)
})

test('migration DDL rejects invalid vector indexes', () => {
	let articles = ydbTable('user_articles', {
		id: uint32('id').notNull().primaryKey(),
		embedding: bytes('embedding').notNull(),
	})

	assert.throws(
		() =>
			vectorIndex({
				distance: 'cosine',
				similarity: 'inner_product',
				vectorType: 'float',
				vectorDimension: 512,
				clusters: 128,
				levels: 2,
			})
				.on(articles.embedding)
				.build(articles),
		/requires exactly one of distance or similarity/u
	)
	assert.throws(
		() =>
			vectorIndex({
				distance: 'cosine',
				vectorType: 'float',
				vectorDimension: 512,
				clusters: 128,
				levels: 0,
			})
				.on(articles.embedding)
				.build(articles),
		/levels must be an integer between 1 and 16/u
	)
	assert.throws(
		() =>
			vectorIndex({
				distance: 'cosine',
				vectorType: 'float',
				vectorDimension: 512,
				clusters: 128,
				levels: 2,
			})
				.on(articles.embedding)
				.local()
				.build(articles),
		/support only GLOBAL/u
	)
	assert.throws(
		() =>
			vectorIndex({
				distance: 'cosine',
				vectorType: 'float',
				vectorDimension: 512,
				clusters: 128,
				levels: 2,
			})
				.on(articles.embedding)
				.async()
				.build(articles),
		/support only SYNC/u
	)
})

test('migration DDL includes inline column unique constraints', () => {
	let users = ydbTable('migration_unique_users', {
		id: integer('id').notNull().primaryKey(),
		email: text('email').notNull().unique(),
		externalId: text('external_id').unique('migration_unique_users_external_unique'),
	})

	let ddl = buildCreateTableSql(users)

	assert.match(
		ddl,
		/INDEX `migration_unique_users_email_unique` GLOBAL UNIQUE SYNC ON \(`email`\)/u
	)
	assert.match(
		ddl,
		/INDEX `migration_unique_users_external_unique` GLOBAL UNIQUE SYNC ON \(`external_id`\)/u
	)
})
