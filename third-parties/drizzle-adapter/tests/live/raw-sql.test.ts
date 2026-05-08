import { test } from 'vitest'
import assert from 'node:assert/strict'
import { sql as yql } from 'drizzle-orm'
import { createLiveContext } from './helpers/context.ts'
import { usersTableName } from './helpers/schema.ts'

let live = createLiveContext()

test('raw sql', async (t) => {
	if (!live.requireLiveYdb(t)) return
	live.describeDbChange(
		t,
		'insert one user row via raw SQL, read it back, delete it, then confirm the row is gone'
	)
	let id = live.baseIntId + 1

	live.log('raw', id)
	await live.deleteUserRows([id])

	try {
		await live.db.execute(
			yql`insert into ${yql.identifier(usersTableName)} (id, name) values (${id}, ${'pinky'})`
		)

		let inserted = await live.db.execute<Array<{ id: number; name: string }>>(
			yql`select id, name from ${yql.identifier(usersTableName)} where id = ${id}`
		)

		assert.deepEqual(inserted, [{ id, name: 'pinky' }])

		await live.db.execute(yql`delete from ${yql.identifier(usersTableName)} where id = ${id}`)

		let remaining = await live.db.execute<Array<{ id: number; name: string }>>(
			yql`select id, name from ${yql.identifier(usersTableName)} where id = ${id}`
		)

		assert.deepEqual(remaining, [])
	} finally {
		await live.deleteUserRows([id])
	}
})
