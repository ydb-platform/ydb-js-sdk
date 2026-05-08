import { test } from 'vitest'
import assert from 'node:assert/strict'
import { relations } from 'drizzle-orm'
import { TransactionRollbackError } from 'drizzle-orm/errors'
import { drizzle, integer, text, ydbTable } from '../../src/index.ts'

let users = ydbTable('users', {
	id: integer('id').notNull(),
	name: text('name').notNull(),
})

let posts = ydbTable('posts', {
	id: integer('id').notNull(),
	authorId: integer('author_id').notNull(),
	title: text('title').notNull(),
})

let schema = {
	users,
	posts,
	usersRelations: relations(users, ({ many }) => ({
		posts: many(posts),
	})),
	postsRelations: relations(posts, ({ one }) => ({
		author: one(users, {
			fields: [posts.authorId],
			references: [users.id],
		}),
	})),
}

test('transaction commit', async () => {
	let transactionConfigs: unknown[] = []
	let logs: Array<{ query: string; params: unknown[] }> = []
	let buildObjectRows = (query: string, values: unknown[]) => {
		let aliases = Array.from(query.matchAll(/ as `([^`]+)`/g), (match) => match[1]!)
		return [Object.fromEntries(aliases.map((alias, index) => [alias, values[index]]))]
	}
	let executeInStore = async (
		query: string,
		_params: unknown[],
		options?: { arrayMode?: boolean }
	) => {
		if (query.startsWith('select')) {
			return {
				rows: options?.arrayMode
					? [[1, 'Rainbow Dash']]
					: buildObjectRows(query, [1, 'Rainbow Dash']),
			}
		}

		return { rows: [] }
	}

	let db = drizzle(
		{
			async execute(query, params, _method, options) {
				return executeInStore(query, params, options)
			},
			async transaction(callback, config) {
				transactionConfigs.push(config)
				return callback({
					async execute(query, params, _method, options) {
						return executeInStore(query, params, options)
					},
				})
			},
		},
		{
			schema,
			logger: {
				logQuery(query, params) {
					logs.push({ query, params: [...params] })
				},
			},
		}
	)

	let result = await db.transaction(
		async (tx) => {
			await tx.insert(users).values({ id: 1, name: 'Rainbow Dash' })

			let row = await tx.query.users.findFirst({
				where: (fields, { eq }) => eq(fields.id, 1),
			})

			return {
				row,
				hasSchema: !!tx._.schema?.users,
			}
		},
		{ accessMode: 'read write', idempotent: false }
	)

	assert.deepEqual(result, {
		row: { id: 1, name: 'Rainbow Dash' },
		hasSchema: true,
	})
	assert.deepEqual(transactionConfigs, [{ accessMode: 'read write', idempotent: false }])
	assert.ok(logs.some(({ query }) => query.startsWith('insert into `users`')))
	assert.ok(
		logs.some(({ query }) =>
			query.startsWith(
				'select `users`.`id` as `__ydb_c0`, `users`.`name` as `__ydb_c1` from `users` `users`'
			)
		)
	)
})

test('transaction rollback', async () => {
	let rolledBack = false

	let db = drizzle(
		{
			async execute() {
				return { rows: [] }
			},
			async transaction(callback) {
				try {
					return await callback({
						async execute() {
							return { rows: [] }
						},
					})
				} catch (error) {
					rolledBack = true
					throw new Error('Transaction failed.', { cause: error })
				}
			},
		},
		{ schema }
	)

	await assert.rejects(
		async () =>
			db.transaction(async (tx) => {
				tx.rollback()
			}),
		TransactionRollbackError
	)

	assert.equal(rolledBack, true)
})
