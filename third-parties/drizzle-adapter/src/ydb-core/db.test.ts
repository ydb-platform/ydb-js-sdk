import { expect, test } from 'vitest'
import { eq, sql as yql } from 'drizzle-orm'
import { drizzle } from '../index.ts'
import { integer, primaryKey, text, ydbTable } from '../schema.ts'
import { YdbDeleteBuilder, YdbInsertBuilder } from '../ydb-core/query-builders/index.ts'
import { dialect, session, users } from '../../tests/helpers/unit-basic.ts'

test('builds CTE-backed select queries via $with/with', () => {
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

	expect(query.sql).toMatch(/^\$sq = \(select/)
	expect(query.sql).toContain('select `sq`.`id`, `sq`.`name` from $sq as `sq`')
	expect(query.params).toEqual([1])
})

test('embeds $count subquery and resolves numeric results', async () => {
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

	expect(result).toBe(5)
	expect(queries[0]).toBe('select count(*) as count from `users` where `users`.`id` = $p0')
	expect(embedded.sql).toBe(
		'select (select count(*) from `users` where `users`.`id` = $p0) as `count`'
	)
	expect(embedded.params).toEqual([2])
})

test('builds insert select with full target columns', () => {
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

	expect(query.sql).toBe(
		'insert into `users` (`id`, `name`, `created_at`, `updated_at`) select $p0 as `id`, `users`.`name`, `users`.`created_at`, `users`.`updated_at` from `users` where `users`.`id` = $p1'
	)
	expect(query.params).toEqual([2, 1])
})

test('supports partial target columns for insert select', () => {
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

	expect(query.sql).toBe(
		'insert into `users` (`id`, `name`) select $p0 as `id`, `users`.`name` from `users` where `users`.`id` = $p1'
	)
	expect(query.params).toEqual([2, 1])
})

test('supports partial target columns for upsert and replace select', () => {
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

	expect(upsertQuery.sql).toBe(
		'upsert into `users` (`id`, `name`) select $p0 as `id`, `users`.`name` from `users`'
	)
	expect(replaceQuery.sql).toBe(
		'replace into `users` (`id`, `name`) select $p0 as `id`, `users`.`name` from `users`'
	)
})

test('rejects insert select with fields missing from the target table', () => {
	expect(() =>
		new YdbInsertBuilder(users, session, dialect).select((qb) =>
			qb
				.select({
					id: users.id,
					missing: users.name,
				})
				.from(users)
		)
	).toThrow(/Insert select error/)
})

test('rejects onDuplicateKeyUpdate combined with insert select', () => {
	expect(() =>
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
			.getSQL()
	).toThrow(/does not support insert\(\)\.select/)
})

test('generates onDuplicateKeyUpdate sql', () => {
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

	expect(query.sql).toMatch(/^\$__ydb_incoming = \(select/)
	expect(query.sql).toContain('upsert into `plain_users` (`id`, `name`) select')
	expect(query.sql).toContain(
		'case when `plain_users`.`id` is null then `__ydb_incoming`.`name` else $p2 end as `name`'
	)
	expect(query.sql).toContain('from $__ydb_incoming as `__ydb_incoming`')
	expect(query.params).toEqual([1, 'insert value', 'updated value'])
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

	expect(query.sql).toContain('upsert into `keyed_users` (`id`, `name`) select')
	expect(query.sql).toContain(
		'left join `keyed_users` on `keyed_users`.`id` = `__ydb_incoming`.`id`'
	)
	expect(query.params).toEqual([1, 'insert value', 'updated value'])
})

test('db exposes native upsert and replace builders', () => {
	let db = drizzle({
		async execute() {
			return { rows: [] }
		},
	})

	expect(db.upsert(users).values({ id: 1, name: 'Twilight' }).toSQL().sql).toBe(
		'upsert into `users` (`id`, `name`) values ($p0, $p1)'
	)
	expect(db.replace(users).values({ id: 1, name: 'Twilight' }).toSQL().sql).toBe(
		'replace into `users` (`id`, `name`, `created_at`, `updated_at`) values ($p0, $p1, $p2, $p3)'
	)
})

test('db exposes native batch mutation builders', () => {
	let db = drizzle({
		async execute() {
			return { rows: [] }
		},
	})

	expect(db.batchUpdate(users).set({ name: 'Twilight' }).where(eq(users.id, 1)).toSQL().sql).toBe(
		'batch update `users` set `name` = $p0, `updated_at` = $p1 where `users`.`id` = $p2'
	)
	expect(db.batchDelete(users).where(eq(users.id, 1)).toSQL().sql).toBe(
		'batch delete from `users` where `users`.`id` = $p0'
	)
})

test('generates delete using sql', () => {
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

	expect(query.sql).toBe(
		'delete from `keyed_users` where `keyed_users`.`id` in (select `keyed_users`.`id` from `keyed_users` cross join `posts` where `keyed_users`.`id` = `posts`.`user_id`)'
	)
	expect(query.params).toEqual([])
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

	expect(results[0]).toEqual([])
	expect(results[1]).toEqual([{ id: 1, name: 'Rainbow Dash' }])
})
