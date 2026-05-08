import { test } from 'vitest'
import assert from 'node:assert/strict'
import { desc, eq, sql as yql } from 'drizzle-orm'
import { createLiveContext } from './helpers/context.ts'
import { posts, postsTableName, users, usersTableName } from './helpers/schema.ts'

let live = createLiveContext()

test('advanced select clauses', async (t) => {
	if (!live.requireLiveYdb(t)) return
	live.describeDbChange(
		t,
		'insert seed users/posts, verify distinct/groupBy/having/limit/offset/distinctOn result sets, then clean all seeded rows'
	)
	let firstUserId = live.baseIntId + 241
	let secondUserId = live.baseIntId + 242
	let thirdUserId = live.baseIntId + 243
	let firstPostId = live.baseIntId + 244
	let secondPostId = live.baseIntId + 245
	let thirdPostId = live.baseIntId + 246

	live.liveQueryLog.length = 0
	live.log(
		'advanced-select',
		firstUserId,
		secondUserId,
		thirdUserId,
		firstPostId,
		secondPostId,
		thirdPostId
	)
	await live.deletePostRows([firstPostId, secondPostId, thirdPostId])
	await live.deleteUserRows([firstUserId, secondUserId, thirdUserId])

	try {
		await live.db.insert(users).values([
			{ id: firstUserId, name: 'apple' },
			{ id: secondUserId, name: 'apple' },
			{ id: thirdUserId, name: 'berry' },
		])

		await live.db.insert(posts).values([
			{ id: firstPostId, userId: firstUserId, title: 'A Tale' },
			{ id: secondPostId, userId: firstUserId, title: 'Zecora' },
			{ id: thirdPostId, userId: secondUserId, title: 'Rainbow Dash' },
		])

		let distinctNames = await live.db
			.selectDistinct({ name: users.name })
			.from(users)
			.where(yql`${users.id} in (${firstUserId}, ${secondUserId}, ${thirdUserId})`)
			.orderBy(users.name)
		let groupedUsers = await live.db
			.select({ userId: posts.userId })
			.from(posts)
			.where(yql`${posts.id} in (${firstPostId}, ${secondPostId}, ${thirdPostId})`)
			.groupBy(posts.userId)
			.having(yql`count(*) > ${1}`)
			.orderBy(posts.userId)
		let pagedPosts = await live.db
			.select({ id: posts.id, title: posts.title })
			.from(posts)
			.where(yql`${posts.id} in (${firstPostId}, ${secondPostId}, ${thirdPostId})`)
			.orderBy(posts.id)
			.limit(2)
			.offset(1)
		let distinctOnRows = (await live.db
			.selectDistinctOn(posts.userId, { userId: posts.userId, title: posts.title })
			.from(posts)
			.where(yql`${posts.id} in (${firstPostId}, ${secondPostId}, ${thirdPostId})`)
			.orderBy(posts.userId, desc(posts.title))) as Array<{ userId: number; title: string }>

		assert.deepEqual(distinctNames, [{ name: 'apple' }, { name: 'berry' }])
		assert.deepEqual(groupedUsers, [{ userId: firstUserId }])
		assert.deepEqual(pagedPosts, [
			{ id: secondPostId, title: 'Zecora' },
			{ id: thirdPostId, title: 'Rainbow Dash' },
		])
		assert.deepEqual(
			[...distinctOnRows].sort((left, right) => left.userId - right.userId),
			[
				{ userId: firstUserId, title: 'Zecora' },
				{ userId: secondUserId, title: 'Rainbow Dash' },
			]
		)
		assert.ok(live.liveQueryLog.some(({ query }) => query.includes('select distinct')))
		assert.ok(live.liveQueryLog.some(({ query }) => query.includes('group by')))
		assert.ok(live.liveQueryLog.some(({ query }) => query.includes('row_number() over')))
	} finally {
		await live.deletePostRows([firstPostId, secondPostId, thirdPostId])
		await live.deleteUserRows([firstUserId, secondUserId, thirdUserId])
	}
})

test('joins and set operators', async (t) => {
	if (!live.requireLiveYdb(t)) return
	live.describeDbChange(
		t,
		'insert users/posts, verify left join and set-operator reads, then delete all seeded rows'
	)
	let firstUserId = live.baseIntId + 261
	let secondUserId = live.baseIntId + 262
	let thirdUserId = live.baseIntId + 263
	let firstPostId = live.baseIntId + 264
	let secondPostId = live.baseIntId + 265

	live.liveQueryLog.length = 0
	live.log('joins-set-ops', firstUserId, secondUserId, thirdUserId, firstPostId, secondPostId)
	await live.deletePostRows([firstPostId, secondPostId])
	await live.deleteUserRows([firstUserId, secondUserId, thirdUserId])

	try {
		await live.db.insert(users).values([
			{ id: firstUserId, name: 'apple' },
			{ id: secondUserId, name: 'apple' },
			{ id: thirdUserId, name: 'berry' },
		])

		await live.db.insert(posts).values([
			{ id: firstPostId, userId: firstUserId, title: 'Lesson Zero' },
			{ id: secondPostId, userId: secondUserId, title: 'Pinkie Keen' },
		])

		let leftJoined = await live.db
			.select()
			.from(users)
			.leftJoin(posts, eq(users.id, posts.userId))
			.where(eq(users.id, thirdUserId))
		let unionRows = await live.db
			.select({ value: users.name })
			.from(users)
			.where(yql`${users.id} in (${firstUserId}, ${secondUserId})`)
			.union(
				live.db.select({ value: users.name }).from(users).where(eq(users.id, thirdUserId))
			)
			.orderBy((fields: { value: unknown }) => fields.value as any)
		let unionAllRows = await live.db
			.select({ value: users.name })
			.from(users)
			.where(eq(users.id, firstUserId))
			.unionAll(
				live.db.select({ value: users.name }).from(users).where(eq(users.id, secondUserId))
			)
			.orderBy((fields: { value: unknown }) => fields.value as any)
		let intersectRows = await live.db
			.select({ value: users.name })
			.from(users)
			.where(yql`${users.id} in (${firstUserId}, ${secondUserId})`)
			.intersect(
				live.db
					.select({ value: users.name })
					.from(users)
					.where(yql`${users.id} in (${secondUserId}, ${thirdUserId})`)
			)
		let exceptRows = await live.db
			.select({ value: users.name })
			.from(users)
			.where(yql`${users.id} in (${firstUserId}, ${thirdUserId})`)
			.except(
				live.db.select({ value: users.name }).from(users).where(eq(users.id, secondUserId))
			)

		assert.deepEqual(leftJoined, [
			{
				[usersTableName]: { id: thirdUserId, name: 'berry' },
				[postsTableName]: null,
			},
		])
		assert.deepEqual(unionRows, [{ value: 'apple' }, { value: 'berry' }])
		assert.deepEqual(unionAllRows, [{ value: 'apple' }, { value: 'apple' }])
		assert.deepEqual(intersectRows, [{ value: 'apple' }])
		assert.deepEqual(exceptRows, [{ value: 'berry' }])
		assert.ok(live.liveQueryLog.some(({ query }) => query.includes('left join')))
		assert.ok(live.liveQueryLog.some(({ query }) => query.includes(' union ')))
		assert.ok(live.liveQueryLog.some(({ query }) => query.includes('union all')))
		assert.ok(live.liveQueryLog.some(({ query }) => query.includes('__ydb_left')))
	} finally {
		await live.deletePostRows([firstPostId, secondPostId])
		await live.deleteUserRows([firstUserId, secondUserId, thirdUserId])
	}
})
