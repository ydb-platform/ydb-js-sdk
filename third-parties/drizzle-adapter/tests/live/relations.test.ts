import { test } from 'vitest'
import assert from 'node:assert/strict'
import { createLiveContext } from './helpers/context.ts'
import { posts, postsTableName, users, usersTableName } from './helpers/schema.ts'

let live = createLiveContext()

test('schema query', async (t) => {
	if (!live.requireLiveYdb(t)) return
	live.describeDbChange(
		t,
		'insert one user, resolve it through schema-aware query API, then delete it again'
	)
	let id = live.baseIntId + 201

	live.liveQueryLog.length = 0
	live.log('schema', id)
	await live.deleteUserRows([id])

	try {
		await live.db.insert(users).values({ id, name: 'twilight sparkle' })

		let inserted = await (live.db as any).query.users.findFirst({
			where: (
				fields: typeof users,
				{ eq }: { eq: (left: unknown, right: unknown) => unknown }
			) => eq(fields.id, id),
		})

		assert.deepEqual(inserted, { id, name: 'twilight sparkle' })
		assert.ok((live.db as any)._.schema?.users)
		assert.ok(
			live.liveQueryLog.some(({ query }) =>
				query.includes(`insert into \`${usersTableName}\``)
			)
		)
		assert.ok(
			live.liveQueryLog.some(({ query }) => query.includes(`from \`${usersTableName}\``))
		)
	} finally {
		await live.deleteUserRows([id])
	}
})

test('findMany', async (t) => {
	if (!live.requireLiveYdb(t)) return
	live.describeDbChange(
		t,
		'insert two users, read them through schema-aware findMany with order/limit, then clean both rows'
	)
	let firstId = live.baseIntId + 221
	let secondId = live.baseIntId + 222

	live.log('many', firstId, secondId)
	await live.deleteUserRows([firstId, secondId])

	try {
		await live.db.insert(users).values([
			{ id: firstId, name: 'apple bloom' },
			{ id: secondId, name: 'sweetie belle' },
		])

		let rows = await (live.db as any).query.users.findMany({
			columns: { id: true, name: true },
			where: (
				fields: typeof users,
				{ inArray }: { inArray: (left: unknown, right: unknown[]) => unknown }
			) => inArray(fields.id, [firstId, secondId]),
			orderBy: (fields: typeof users, { desc }: { desc: (value: unknown) => unknown }) =>
				desc(fields.id),
			limit: 2,
		})

		assert.deepEqual(rows, [
			{ id: secondId, name: 'sweetie belle' },
			{ id: firstId, name: 'apple bloom' },
		])
	} finally {
		await live.deleteUserRows([firstId, secondId])
	}
})

test('many relation hydration', async (t) => {
	if (!live.requireLiveYdb(t)) return
	live.describeDbChange(
		t,
		'insert one user and two posts, resolve users.posts through schema-aware query API, then clean rows'
	)
	let userId = live.baseIntId + 241
	let firstPostId = live.baseIntId + 242
	let secondPostId = live.baseIntId + 243

	live.liveQueryLog.length = 0
	live.log('users.posts', userId, firstPostId, secondPostId)
	await live.deletePostRows([firstPostId, secondPostId])
	await live.deleteUserRows([userId])

	try {
		await live.db.insert(users).values({ id: userId, name: 'pinkie pie' })
		await live.db.insert(posts).values([
			{ id: firstPostId, userId, title: 'cupcakes' },
			{ id: secondPostId, userId, title: 'party cannon' },
		])

		let row = await (live.db as any).query.users.findFirst({
			columns: { id: true, name: true },
			where: (
				fields: typeof users,
				{ eq }: { eq: (left: unknown, right: unknown) => unknown }
			) => eq(fields.id, userId),
			with: {
				posts: {
					columns: { id: true, title: true },
					orderBy: (
						fields: typeof posts,
						{ asc }: { asc: (value: unknown) => unknown }
					) => asc(fields.id),
				},
			},
		})

		assert.deepEqual(row, {
			id: userId,
			name: 'pinkie pie',
			posts: [
				{ id: firstPostId, title: 'cupcakes' },
				{ id: secondPostId, title: 'party cannon' },
			],
		})
		assert.ok(
			live.liveQueryLog.some(({ query }) => query.includes(`from \`${usersTableName}\``))
		)
		assert.ok(
			live.liveQueryLog.some(({ query }) => query.includes(`from \`${postsTableName}\``))
		)
	} finally {
		await live.deletePostRows([firstPostId, secondPostId])
		await live.deleteUserRows([userId])
	}
})

test('one relation hydration', async (t) => {
	if (!live.requireLiveYdb(t)) return
	live.describeDbChange(
		t,
		'insert one user and one post, resolve posts.author through schema-aware query API, then clean rows'
	)
	let userId = live.baseIntId + 261
	let postId = live.baseIntId + 262

	live.liveQueryLog.length = 0
	live.log('posts.author', userId, postId)
	await live.deletePostRows([postId])
	await live.deleteUserRows([userId])

	try {
		await live.db.insert(users).values({ id: userId, name: 'fluttershy' })
		await live.db.insert(posts).values({ id: postId, userId, title: 'tea time' })

		let row = await (live.db as any).query.posts.findFirst({
			columns: { id: true, title: true },
			where: (
				fields: typeof posts,
				{ eq }: { eq: (left: unknown, right: unknown) => unknown }
			) => eq(fields.id, postId),
			with: {
				author: {
					columns: { id: true, name: true },
				},
			},
		})

		assert.deepEqual(row, {
			id: postId,
			title: 'tea time',
			author: {
				id: userId,
				name: 'fluttershy',
			},
		})
		assert.ok(
			live.liveQueryLog.some(({ query }) => query.includes(`from \`${postsTableName}\``))
		)
		assert.ok(
			live.liveQueryLog.some(({ query }) => query.includes(`from \`${usersTableName}\``))
		)
	} finally {
		await live.deletePostRows([postId])
		await live.deleteUserRows([userId])
	}
})
