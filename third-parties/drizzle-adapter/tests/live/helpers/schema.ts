import {
	bigint,
	boolean,
	bytes,
	date,
	datetime,
	double,
	float,
	integer,
	json,
	jsonDocument,
	relations,
	text,
	timestamp,
	uint32,
	uint64,
	uuid,
	ydbTable,
	yson,
} from '../../../src/index.ts'
import { loadTestEnv } from '../../helpers/load-env.ts'
import { inject } from 'vitest'

loadTestEnv()

function getSafeTableName(envName: string, fallback: string): string {
	let tableName = process.env[envName] ?? fallback

	if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(tableName)) {
		throw new Error(`Invalid YDB table name in ${envName}: ${tableName}`)
	}

	return tableName
}

export let ydbUrl = process.env['YDB_CONNECTION_STRING'] ?? inject('connectionString')
export let usersTableName = getSafeTableName('YDB_TEST_TABLE', 'adapter_test_users')
export let postsTableName = getSafeTableName('YDB_POSTS_TEST_TABLE', 'adapter_test_posts')
export let typesTableName = getSafeTableName('YDB_TYPES_TEST_TABLE', 'adapter_test_column_types')
export let keepData = process.env['YDB_TEST_KEEP_DATA'] === '1'
export let verbose = process.env['YDB_TEST_VERBOSE'] === '1'
export let requireLiveYdb = process.env['YDB_TEST_REQUIRE_LIVE'] === '1'

export let users = ydbTable(usersTableName, {
	id: integer('id').notNull().primaryKey(),
	name: text('name').notNull(),
})

export let posts = ydbTable(postsTableName, {
	id: integer('id').notNull().primaryKey(),
	userId: integer('user_id').notNull(),
	title: text('title').notNull(),
})

export let usersRelations = relations(users, ({ many }) => ({
	posts: many(posts),
}))

export let postsRelations = relations(posts, ({ one }) => ({
	author: one(users, {
		fields: [posts.userId],
		references: [users.id],
	}),
}))

export let typesTable = ydbTable(typesTableName, {
	id: uint64('id').notNull().primaryKey(),
	flag: boolean('flag'),
	signed64: bigint('signed64'),
	u32: uint32('u32'),
	f32: float('f32'),
	f64: double('f64'),
	bytesValue: bytes('bytes_value'),
	dateValue: date('date_value'),
	datetimeValue: datetime('datetime_value'),
	timestampValue: timestamp('timestamp_value'),
	jsonValue: json('json_value'),
	jsonDocumentValue: jsonDocument('json_document_value'),
	uuidValue: uuid('uuid_value'),
	ysonValue: yson('yson_value'),
})

export let liveSchema = { users, posts, typesTable, usersRelations, postsRelations }
