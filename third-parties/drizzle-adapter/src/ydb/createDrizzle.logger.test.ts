import { test } from 'vitest'
import * as assert from 'node:assert/strict'
import { sql as yql } from 'drizzle-orm'
import { drizzle } from '../index.ts'
import { integer, text, ydbTable } from '../schema.ts'

let users = ydbTable('users', {
	id: integer('id').notNull(),
	name: text('name').notNull(),
})

test('forwards executed queries and bound params to the configured logger', async () => {
	let logs: Array<{ query: string; params: unknown[] }> = []

	let db = drizzle(
		{
			async execute(query, params) {
				return {
					rows: query.startsWith('select') ? [{ value: params[0] }] : [],
				}
			},
		},
		{
			logger: {
				logQuery(query, params) {
					logs.push({ query, params: [...params] })
				},
			},
		}
	)

	await db.execute<{ value: number }[]>(yql`select ${123} as value`)
	await db.insert(users).values({ id: 1, name: 'Pinkie Pie' })

	assert.equal(logs.length, 2)
	assert.equal(logs[0]?.query, 'select $p0 as value')
	assert.deepEqual(logs[0]?.params, [123])
	assert.equal(logs[1]?.query, 'insert into `users` (`id`, `name`) values ($p0, $p1)')
	assert.deepEqual(logs[1]?.params, [1, 'Pinkie Pie'])
})
