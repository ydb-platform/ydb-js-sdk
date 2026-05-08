import { test } from 'vitest'
import assert from 'node:assert/strict'
import { eq, sql as yql } from 'drizzle-orm'
import { YdbDriver, drizzle } from '../../src/index.ts'
import { createLiveContext } from './helpers/context.ts'
import { liveSchema, users, usersTableName, ydbUrl } from './helpers/schema.ts'

let live = createLiveContext()

test('createDrizzle inputs', async (t) => {
	if (!live.requireLiveYdb(t)) return
	live.describeDbChange(
		t,
		'no persistent data change; verifies that connection-string and callback inputs execute against the same live database'
	)
	let connectionDb = drizzle({
		connectionString: ydbUrl,
		schema: liveSchema,
	})
	let callbackCalls: Array<{ query: string; method: string; params: unknown[] }> = []
	let callbackDb = drizzle(
		async (query, params, method, options) => {
			callbackCalls.push({ query, method, params: [...params] })
			return live.db.$client.execute(query, params, method, options)
		},
		{ schema: liveSchema }
	)

	try {
		await (connectionDb.$client as YdbDriver).ready?.()

		let connectionRows = await connectionDb.execute<Array<{ value: number }>>(
			yql`select ${1} as ${yql.identifier('value')}`
		)
		let callbackRows = await callbackDb.execute<Array<{ value: number }>>(
			yql`select ${2} as ${yql.identifier('value')}`
		)

		assert.deepEqual(connectionRows, [{ value: 1 }])
		assert.deepEqual(callbackRows, [{ value: 2 }])
		assert.equal(callbackCalls.length, 1)
		assert.equal(callbackCalls[0]?.method, 'execute')
		assert.equal(callbackCalls[0]?.query, 'select $p0 as `value`')
	} finally {
		;(connectionDb.$client as YdbDriver).close()
	}
})

test('builder CRUD', async (t) => {
	if (!live.requireLiveYdb(t)) return
	live.describeDbChange(
		t,
		'insert two users, update one, delete one, then leave the table clean again'
	)
	let firstId = live.baseIntId + 101
	let secondId = live.baseIntId + 102

	live.log('crud', firstId, secondId)
	await live.deleteUserRows([firstId, secondId])

	try {
		await live.db.insert(users).values([
			{ id: firstId, name: 'rarity' },
			{ id: secondId, name: 'applejack' },
		])

		let inserted = live.sortById(
			(await live.db
				.select()
				.from(users)
				.where(yql`${users.id} IN (${firstId}, ${secondId})`)) as Array<{
				id: number
				name: string
			}>
		)

		assert.deepEqual(inserted, [
			{ id: firstId, name: 'rarity' },
			{ id: secondId, name: 'applejack' },
		])

		await live.db.update(users).set({ name: 'rarity updated' }).where(eq(users.id, firstId))
		await live.db.delete(users).where(eq(users.id, secondId))

		let remaining = (await live.db
			.select()
			.from(users)
			.where(yql`${users.id} IN (${firstId}, ${secondId})`)) as Array<{
			id: number
			name: string
		}>

		assert.deepEqual(remaining, [{ id: firstId, name: 'rarity updated' }])
	} finally {
		await live.deleteUserRows([firstId, secondId])
	}
})

test('db helpers', async (t) => {
	if (!live.requireLiveYdb(t)) return
	live.describeDbChange(
		t,
		'insert one user, read it through execute/all/get/values helpers, then delete it and confirm helper-layer logging'
	)
	let id = live.baseIntId + 151

	live.liveQueryLog.length = 0
	live.log('helpers', id)
	await live.deleteUserRows([id])

	try {
		await live.db.execute(live.db.insert(users).values({ id, name: 'sunset shimmer' }))

		let selectQuery = live.db.select().from(users).where(eq(users.id, id))
		let selectedRows = (await selectQuery.prepare('select_user_prepared').execute()) as Array<{
			id: number
			name: string
		}>
		let executeRows = await live.db.execute<Array<{ id: number; name: string }>>(selectQuery)
		let allRows = await live.db.all<{ id: number; name: string }>(selectQuery)
		let oneRow = await live.db.get<{ id: number; name: string }>(selectQuery)
		let valueRows = await live.db.values<[number, string]>(selectQuery)

		assert.deepEqual(selectedRows, [{ id, name: 'sunset shimmer' }])
		assert.deepEqual(executeRows, [{ id, name: 'sunset shimmer' }])
		assert.deepEqual(allRows, [{ id, name: 'sunset shimmer' }])
		assert.deepEqual(oneRow, { id, name: 'sunset shimmer' })
		assert.deepEqual(valueRows, [[id, 'sunset shimmer']])

		await live.db.execute(
			live.db.update(users).set({ name: 'sunset updated' }).where(eq(users.id, id))
		)
		await live.db.execute(live.db.delete(users).where(eq(users.id, id)))

		let remainingRows = await live.db.select().from(users).where(eq(users.id, id))
		assert.deepEqual(remainingRows, [])
		assert.ok(
			live.liveQueryLog.some(({ query }) =>
				query.includes(`insert into \`${usersTableName}\``)
			)
		)
		assert.ok(live.liveQueryLog.some(({ query }) => query.includes('update')))
		assert.ok(live.liveQueryLog.some(({ query }) => query.includes('delete from')))
	} finally {
		await live.deleteUserRows([id])
	}
})
