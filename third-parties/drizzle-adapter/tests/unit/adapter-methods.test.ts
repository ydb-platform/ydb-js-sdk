import { test } from 'vitest'
import assert from 'node:assert/strict'
import { eq, sql as yql } from 'drizzle-orm'
import { drizzle, integer, primaryKey, text, ydbTable } from '../../src/index.ts'
import { YdbDeleteBuilder, YdbInsertBuilder } from '../../src/ydb-core/query-builders/index.ts'
import { dialect, session, users } from '../helpers/unit-basic.ts'

test('db $with()/with() builds CTE-backed select queries', () => {
	let db = drizzle({
		async execute() {
			return { rows: [] }
		},
	})

	let sq = db.$with('sq').as(
		db
			.select({
				id: users.id,
				name: users.name,
			})
			.from(users)
			.where(eq(users.id, 1))
	)

	let query = db.with(sq).select().from(sq).toSQL()

	assert.ok(query.sql.startsWith('$sq = (select'))
	assert.ok(query.sql.includes('select `sq`.`id`, `sq`.`name` from $sq as `sq`'))
	assert.deepEqual(query.params, [1])
})

test('db $count() embeds count sql and resolves numeric results', async () => {
	let queries: string[] = []
	let db = drizzle({
		async execute(query) {
			queries.push(query)
			return { rows: [[5]] }
		},
	})

	let result = await db.$count(users, eq(users.id, 1))
	let embedded = dialect.sqlToQuery(
		yql`select ${db.$count(users, eq(users.id, 2))} as ${yql.identifier('count')}`
	)

	assert.equal(result, 5)
	assert.equal(queries[0], 'select count(*) as count from `users` where `users`.`id` = $p0')
	assert.equal(
		embedded.sql,
		'select (select count(*) from `users` where `users`.`id` = $p0) as `count`'
	)
	assert.deepEqual(embedded.params, [2])
})

test('insert select sql', () => {
	let query = dialect.sqlToQuery(
		new YdbInsertBuilder(users, session, dialect)
			.select((qb) =>
				qb
					.select({
						id: yql<number>`${2}`.as('id'),
						name: users.name,
						createdAt: users.createdAt,
						updatedAt: users.updatedAt,
					})
					.from(users)
					.where(eq(users.id, 1))
			)
			.getSQL()
	)

	assert.equal(
		query.sql,
		'insert into `users` (`id`, `name`, `created_at`, `updated_at`) select $p0 as `id`, `users`.`name`, `users`.`created_at`, `users`.`updated_at` from `users` where `users`.`id` = $p1'
	)
	assert.deepEqual(query.params, [2, 1])
})

test('insert select supports partial target columns', () => {
	let query = dialect.sqlToQuery(
		new YdbInsertBuilder(users, session, dialect)
			.select((qb) =>
				qb
					.select({
						id: yql<number>`${2}`.as('id'),
						name: users.name,
					})
					.from(users)
					.where(eq(users.id, 1))
			)
			.getSQL()
	)

	assert.equal(
		query.sql,
		'insert into `users` (`id`, `name`) select $p0 as `id`, `users`.`name` from `users` where `users`.`id` = $p1'
	)
	assert.deepEqual(query.params, [2, 1])
})

test('upsert and replace select support partial target columns', () => {
	let upsertQuery = dialect.sqlToQuery(
		drizzle({
			async execute() {
				return { rows: [] }
			},
		})
			.upsert(users)
			.select((qb) =>
				qb
					.select({
						id: yql<number>`${2}`.as('id'),
						name: users.name,
					})
					.from(users)
			)
			.getSQL()
	)
	let replaceQuery = dialect.sqlToQuery(
		drizzle({
			async execute() {
				return { rows: [] }
			},
		})
			.replace(users)
			.select((qb) =>
				qb
					.select({
						id: yql<number>`${3}`.as('id'),
						name: users.name,
					})
					.from(users)
			)
			.getSQL()
	)

	assert.equal(
		upsertQuery.sql,
		'upsert into `users` (`id`, `name`) select $p0 as `id`, `users`.`name` from `users`'
	)
	assert.equal(
		replaceQuery.sql,
		'replace into `users` (`id`, `name`) select $p0 as `id`, `users`.`name` from `users`'
	)
})

test('insert select rejects mismatched fields', () => {
	assert.throws(
		() =>
			new YdbInsertBuilder(users, session, dialect).select((qb) =>
				qb
					.select({
						id: users.id,
						missing: users.name,
					})
					.from(users)
			),
		/Insert select error/
	)
})

test('onDuplicateKeyUpdate rejects insert select', () => {
	assert.throws(
		() =>
			new YdbInsertBuilder(users, session, dialect)
				.select((qb) =>
					qb
						.select({
							id: users.id,
							name: users.name,
							createdAt: users.createdAt,
							updatedAt: users.updatedAt,
						})
						.from(users)
				)
				.onDuplicateKeyUpdate({ set: { name: 'updated' } })
				.getSQL(),
		/does not support insert\(\)\.select/
	)
})

test('onDuplicateKeyUpdate sql', () => {
	let plainUsers = ydbTable('plain_users', {
		id: integer('id').notNull().primaryKey(),
		name: text('name').notNull(),
	})
	let query = dialect.sqlToQuery(
		new YdbInsertBuilder(plainUsers, session, dialect)
			.values({ id: 1, name: 'insert value' })
			.onDuplicateKeyUpdate({ set: { name: 'updated value' } })
			.getSQL()
	)

	assert.ok(query.sql.startsWith('$__ydb_incoming = (select'))
	assert.ok(query.sql.includes('upsert into `plain_users` (`id`, `name`) select'))
	assert.ok(
		query.sql.includes(
			'case when `plain_users`.`id` is null then `__ydb_incoming`.`name` else $p2 end as `name`'
		)
	)
	assert.ok(query.sql.includes('from $__ydb_incoming as `__ydb_incoming`'))
	assert.deepEqual(query.params, [1, 'insert value', 'updated value'])
})

test('onDuplicateKeyUpdate supports table-level primary keys', () => {
	let keyedUsers = ydbTable(
		'keyed_users',
		{
			id: integer('id').notNull(),
			name: text('name').notNull(),
		},
		(table) => [primaryKey(table.id)]
	)
	let query = dialect.sqlToQuery(
		new YdbInsertBuilder(keyedUsers, session, dialect)
			.values({ id: 1, name: 'insert value' })
			.onDuplicateKeyUpdate({ set: { name: 'updated value' } })
			.getSQL()
	)

	assert.ok(query.sql.includes('upsert into `keyed_users` (`id`, `name`) select'))
	assert.ok(
		query.sql.includes('left join `keyed_users` on `keyed_users`.`id` = `__ydb_incoming`.`id`')
	)
	assert.deepEqual(query.params, [1, 'insert value', 'updated value'])
})

test('db exposes native upsert and replace builders', () => {
	let db = drizzle({
		async execute() {
			return { rows: [] }
		},
	})

	assert.equal(
		db.upsert(users).values({ id: 1, name: 'Twilight' }).toSQL().sql,
		'upsert into `users` (`id`, `name`) values ($p0, $p1)'
	)
	assert.equal(
		db.replace(users).values({ id: 1, name: 'Twilight' }).toSQL().sql,
		'replace into `users` (`id`, `name`, `created_at`, `updated_at`) values ($p0, $p1, $p2, $p3)'
	)
})

test('db exposes native batch mutation builders', () => {
	let db = drizzle({
		async execute() {
			return { rows: [] }
		},
	})

	assert.equal(
		db.batchUpdate(users).set({ name: 'Twilight' }).where(eq(users.id, 1)).toSQL().sql,
		'batch update `users` set `name` = $p0, `updated_at` = $p1 where `users`.`id` = $p2'
	)
	assert.equal(
		db.batchDelete(users).where(eq(users.id, 1)).toSQL().sql,
		'batch delete from `users` where `users`.`id` = $p0'
	)
})

test('delete using sql', () => {
	let keyedUsers = ydbTable('keyed_users', {
		id: integer('id').notNull().primaryKey(),
		name: text('name').notNull(),
	})
	let query = dialect.sqlToQuery(
		new YdbDeleteBuilder(keyedUsers, session, dialect)
			.using(yql.identifier('posts'))
			.where(yql`${keyedUsers.id} = ${yql.identifier('posts')}.${yql.identifier('user_id')}`)
			.getSQL()
	)

	assert.equal(
		query.sql,
		'delete from `keyed_users` where `keyed_users`.`id` in (select `keyed_users`.`id` from `keyed_users` cross join `posts` where `keyed_users`.`id` = `posts`.`user_id`)'
	)
	assert.deepEqual(query.params, [])
})

test('session.batch() executes builders sequentially and returns mapped results', async () => {
	let db = drizzle({
		async execute(query, _params, _method, options) {
			if (query.startsWith('insert into `users`')) {
				return { rows: [] }
			}

			if (options?.arrayMode) {
				return { rows: [[1, 'Rainbow Dash']] }
			}

			return { rows: [{ id: 1, name: 'Rainbow Dash' }] }
		},
	})

	let results = await db._.session.batch([
		db.insert(users).values({ id: 1, name: 'Rainbow Dash' }),
		db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, 1)),
	] as const)

	assert.deepEqual(results[0], [])
	assert.deepEqual(results[1], [{ id: 1, name: 'Rainbow Dash' }])
})
