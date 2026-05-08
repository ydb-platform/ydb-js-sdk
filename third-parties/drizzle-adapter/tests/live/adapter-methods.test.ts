import { test } from 'vitest'
import assert from 'node:assert/strict'
import { and, eq, sql as yql } from 'drizzle-orm'
import {
	buildCreateTableSql,
	columnFamily,
	integer,
	partitionByHash,
	tableOptions,
	text,
	ttl,
	uint32,
	ydbTable,
} from '../../src/index.ts'
import { createLiveContext } from './helpers/context.ts'
import { ignoreUnsupportedYqlFeature } from './helpers/errors.ts'
import { posts, users } from './helpers/schema.ts'

let live = createLiveContext()

test('cte helpers and count builder', async (t) => {
	if (!live.requireLiveYdb(t)) return
	live.describeDbChange(
		t,
		'insert one user, query it through a CTE, and verify db.$count() against the live table'
	)
	let userId = live.baseIntId + 401
	let userName = 'cte pony'

	live.liveQueryLog.length = 0
	await live.deleteUserRows([userId])

	try {
		await live.db.insert(users).values({ id: userId, name: userName })

		let count = await live.db.$count(users, eq(users.id, userId))
		let sq = live.db.$with('sq_users').as(
			live.db
				.select({
					id: users.id,
					name: users.name,
				})
				.from(users)
				.where(eq(users.id, userId))
		)
		let rows = await live.db.with(sq).select().from(sq)

		assert.equal(count, 1)
		assert.deepEqual(rows, [{ id: userId, name: userName }])
		assert.ok(live.liveQueryLog.some(({ query }) => query.startsWith('$sq_users = (select')))
		assert.ok(live.liveQueryLog.some(({ query }) => query.includes('select count(*) as count')))
	} finally {
		await live.deleteUserRows([userId])
	}
})

test('insert select', async (t) => {
	if (!live.requireLiveYdb(t)) return
	live.describeDbChange(
		t,
		'insert one source row, then insert a second row via insert().select(...) and verify both exist'
	)
	let sourceId = live.baseIntId + 402
	let copiedId = live.baseIntId + 403

	await live.deleteUserRows([sourceId, copiedId])

	try {
		await live.db.insert(users).values({ id: sourceId, name: 'insert select source' })

		await live.db.insert(users).select((qb) =>
			qb
				.select({
					id: yql<number>`${copiedId}`.as('id'),
					name: users.name,
				})
				.from(users)
				.where(eq(users.id, sourceId))
		)

		let rows = (await live.db
			.select()
			.from(users)
			.where(yql`${users.id} in (${sourceId}, ${copiedId})`)) as Array<{
			id: number
			name: string
		}>

		assert.deepEqual(live.sortById(rows), [
			{ id: sourceId, name: 'insert select source' },
			{ id: copiedId, name: 'insert select source' },
		])
	} finally {
		await live.deleteUserRows([sourceId, copiedId])
	}
})

test('onDuplicateKeyUpdate', async (t) => {
	if (!live.requireLiveYdb(t)) return
	live.describeDbChange(
		t,
		'exercise onDuplicateKeyUpdate() for both conflict and insert paths on the live users table'
	)
	let existingId = live.baseIntId + 407
	let newId = live.baseIntId + 408

	await live.deleteUserRows([existingId, newId])

	try {
		await live.db.insert(users).values({ id: existingId, name: 'existing value' })

		await live.db
			.insert(users)
			.values({ id: existingId, name: 'insert path' })
			.onDuplicateKeyUpdate({ set: { name: 'updated value' } })

		await live.db
			.insert(users)
			.values({ id: newId, name: 'fresh value' })
			.onDuplicateKeyUpdate({ set: { name: 'should not win on insert' } })

		let rows = (await live.db
			.select()
			.from(users)
			.where(yql`${users.id} in (${existingId}, ${newId})`)) as Array<{
			id: number
			name: string
		}>

		assert.deepEqual(live.sortById(rows), [
			{ id: existingId, name: 'updated value' },
			{ id: newId, name: 'fresh value' },
		])
		assert.ok(
			live.liveQueryLog.some(({ query }) => query.startsWith('$__ydb_incoming = (select'))
		)
		assert.ok(live.liveQueryLog.some(({ query }) => query.includes('upsert into')))
	} finally {
		await live.deleteUserRows([existingId, newId])
	}
})

test('mutation returning', async (t) => {
	if (!live.requireLiveYdb(t)) return
	live.describeDbChange(
		t,
		'exercise INSERT/UPSERT/UPDATE/DELETE RETURNING against the live users table'
	)
	let insertId = live.baseIntId + 421
	let upsertId = live.baseIntId + 422
	let deleteId = live.baseIntId + 423

	await live.deleteUserRows([insertId, upsertId, deleteId])

	try {
		let inserted = await live.db
			.insert(users)
			.values({ id: insertId, name: 'returning insert' })
			.returning({ id: users.id, name: users.name })
		let upserted = await live.db
			.upsert(users)
			.values({ id: upsertId, name: 'returning upsert' })
			.returning({ id: users.id, name: users.name })
		let updated = await live.db
			.update(users)
			.set({ name: 'returning updated' })
			.where(eq(users.id, insertId))
			.returning({ id: users.id, name: users.name })

		await live.db.insert(users).values({ id: deleteId, name: 'returning delete' })
		let deleted = await live.db
			.delete(users)
			.where(eq(users.id, deleteId))
			.returning({ id: users.id, name: users.name })

		assert.deepEqual(inserted, [{ id: insertId, name: 'returning insert' }])
		assert.deepEqual(upserted, [{ id: upsertId, name: 'returning upsert' }])
		assert.deepEqual(updated, [{ id: insertId, name: 'returning updated' }])
		assert.deepEqual(deleted, [{ id: deleteId, name: 'returning delete' }])
	} finally {
		await live.deleteUserRows([insertId, upsertId, deleteId])
	}
})

test('native set and batch mutations', async (t) => {
	if (!live.requireLiveYdb(t)) return
	live.describeDbChange(
		t,
		'create a keyed temp table and exercise UPDATE ON, DELETE ON, BATCH UPDATE and BATCH DELETE'
	)
	let suffix = live.baseIntId + 431
	let tableName = `set_mutations_${suffix}`
	let keyedUsers = ydbTable(tableName, {
		id: integer('id').notNull().primaryKey(),
		name: text('name').notNull(),
	})

	await live.db.execute(yql.raw(`DROP TABLE IF EXISTS \`${tableName}\``))

	try {
		await live.db.execute(yql.raw(buildCreateTableSql(keyedUsers, { ifNotExists: true })))
		await live.db.insert(keyedUsers).values([
			{ id: 1, name: 'update target' },
			{ id: 2, name: 'delete target' },
			{ id: 3, name: 'batch target' },
		])

		let updated = await live.db
			.update(keyedUsers)
			.on((qb) =>
				qb
					.select({
						id: keyedUsers.id,
						name: yql<string>`${'set updated'}`.as('name'),
					})
					.from(keyedUsers)
					.where(eq(keyedUsers.id, 1))
			)
			.returning({ id: keyedUsers.id, name: keyedUsers.name })
		let deleted = await live.db
			.delete(keyedUsers)
			.on((qb) =>
				qb.select({ id: keyedUsers.id }).from(keyedUsers).where(eq(keyedUsers.id, 2))
			)
			.returning({ id: keyedUsers.id })

		let batchUpdateUnsupported = await ignoreUnsupportedYqlFeature('BATCH UPDATE', () =>
			live.db
				.batchUpdate(keyedUsers)
				.set({ name: 'batch updated' })
				.where(eq(keyedUsers.id, 3))
		)
		let batchUpdated = batchUpdateUnsupported
			? [{ id: 3, name: 'batch target' }]
			: await live.db.select().from(keyedUsers).where(eq(keyedUsers.id, 3))
		let batchDeleteUnsupported = await ignoreUnsupportedYqlFeature('BATCH DELETE', () =>
			live.db.batchDelete(keyedUsers).where(eq(keyedUsers.id, 3))
		)
		let batchDeleted = batchDeleteUnsupported
			? [{ id: 3, name: 'batch target' }]
			: await live.db.select().from(keyedUsers).where(eq(keyedUsers.id, 3))

		assert.deepEqual(updated, [{ id: 1, name: 'set updated' }])
		assert.deepEqual(deleted, [{ id: 2 }])
		if (!batchUpdateUnsupported) {
			assert.deepEqual(batchUpdated, [{ id: 3, name: 'batch updated' }])
		}

		if (!batchDeleteUnsupported) {
			assert.deepEqual(batchDeleted, [])
		}
	} finally {
		await live.db.execute(yql.raw(`DROP TABLE IF EXISTS \`${tableName}\``))
	}
})

test('advanced table DDL', async (t) => {
	if (!live.requireLiveYdb(t)) return
	live.describeDbChange(
		t,
		'create a temp table with table options, partitioning, TTL and column-family DDL, then verify it accepts rows'
	)
	let suffix = live.baseIntId + 441
	let tableName = `advanced_ddl_${suffix}`
	let events = ydbTable(
		tableName,
		{
			id: integer('id').notNull().primaryKey(),
			payload: text('payload'),
			expiresAt: uint32('expires_at').notNull(),
		},
		(table) => [
			columnFamily('cold', { compression: 'lz4' }).columns(table.payload),
			partitionByHash(table.id),
			ttl(table.expiresAt, 'P1D', { unit: 'SECONDS' }),
			tableOptions({
				AUTO_PARTITIONING_BY_SIZE: 'ENABLED',
				AUTO_PARTITIONING_PARTITION_SIZE_MB: 512,
			}),
		]
	)

	await live.db.execute(yql.raw(`DROP TABLE IF EXISTS \`${tableName}\``))

	try {
		await live.db.execute(yql.raw(buildCreateTableSql(events, { ifNotExists: true })))
		await live.db
			.insert(events)
			.values({ id: 1, payload: 'advanced ddl', expiresAt: 4_102_444_800 })

		let rows = await live.db.select().from(events).where(eq(events.id, 1))
		assert.deepEqual(rows, [{ id: 1, payload: 'advanced ddl', expiresAt: 4_102_444_800 }])
	} finally {
		await live.db.execute(yql.raw(`DROP TABLE IF EXISTS \`${tableName}\``))
	}
})

test('delete using', async (t) => {
	if (!live.requireLiveYdb(t)) return
	live.describeDbChange(
		t,
		'delete a user row through delete().using(posts) with a correlated EXISTS-based condition'
	)
	let userId = live.baseIntId + 404
	let postId = live.baseIntId + 405

	await live.deletePostRows([postId])
	await live.deleteUserRows([userId])

	try {
		await live.db.insert(users).values({ id: userId, name: 'delete using target' })
		await live.db.insert(posts).values({ id: postId, userId, title: 'delete using post' })

		await live.db
			.delete(users)
			.using(posts)
			.where(and(eq(users.id, posts.userId), eq(users.id, userId), eq(posts.id, postId)))

		let remainingUsers = (await live.db
			.select()
			.from(users)
			.where(eq(users.id, userId))) as Array<{ id: number; name: string }>
		let remainingPosts = (await live.db
			.select()
			.from(posts)
			.where(eq(posts.id, postId))) as Array<{
			id: number
			userId: number
			title: string
		}>

		assert.deepEqual(remainingUsers, [])
		assert.deepEqual(remainingPosts, [{ id: postId, userId, title: 'delete using post' }])
		assert.ok(live.liveQueryLog.some(({ query }) => query.includes(' in (select ')))
	} finally {
		await live.deletePostRows([postId])
		await live.deleteUserRows([userId])
	}
})

test('session batch', async (t) => {
	if (!live.requireLiveYdb(t)) return
	live.describeDbChange(
		t,
		'execute an insert and a follow-up select through session.batch() against the live database'
	)
	let userId = live.baseIntId + 406

	await live.deleteUserRows([userId])

	try {
		let results = await live.db._.session.batch([
			live.db.insert(users).values({ id: userId, name: 'batch user' }),
			live.db.select().from(users).where(eq(users.id, userId)),
		] as const)

		assert.deepEqual(results[0], [])
		assert.deepEqual(results[1], [{ id: userId, name: 'batch user' }])
	} finally {
		await live.deleteUserRows([userId])
	}
})
