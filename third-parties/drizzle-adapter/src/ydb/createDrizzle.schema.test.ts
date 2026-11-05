import { test } from 'vitest'
import * as assert from 'node:assert/strict'
import { relations } from 'drizzle-orm'
import { drizzle } from '../index.ts'
import { integer, text, ydbTable } from '../schema.ts'

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

test('extracts relational schema config from createDrizzle', async () => {
	let executedQueries: string[] = []
	let buildObjectRows = (query: string, values: unknown[]) => {
		let aliases = Array.from(query.matchAll(/ as `([^`]+)`/g), (match) => match[1]!)
		return [Object.fromEntries(aliases.map((alias, index) => [alias, values[index]]))]
	}

	let db = drizzle(
		{
			async execute(query, _params, _method, options) {
				executedQueries.push(query)

				if (query.includes('from `users`')) {
					return {
						rows: options?.arrayMode
							? [[1, 'Twilight Sparkle']]
							: buildObjectRows(query, [1, 'Twilight Sparkle']),
					}
				}

				return { rows: [] }
			},
		},
		{ schema }
	)

	let relationalSchema = (db as any)._.schema

	assert.deepEqual(Object.keys(relationalSchema).sort(), ['posts', 'users'])
	assert.equal(relationalSchema.users.tsName, 'users')
	assert.equal(relationalSchema.posts.dbName, 'posts')
	assert.ok(Object.values((db as any)._.tableNamesMap).includes('users'))
	assert.deepEqual(Object.keys((db as any).query).sort(), ['posts', 'users'])
	assert.equal(Object.hasOwn((db as any).query, 'users'), true)
	assert.equal('users' in (db as any).query, true)
	assert.equal('missing' in (db as any).query, false)
	assert.ok((db as any).query.users)
	assert.ok((db as any).query.posts)
	assert.equal((db as any).query.users, (db as any).query.users)

	let many = await (db as any).query.users.findMany()
	let first = await (db as any).query.users.findFirst({
		where: (fields: typeof users, { eq }: { eq: (left: unknown, right: unknown) => unknown }) =>
			eq(fields.id, 1),
	})

	let firstViaGet = await db.get<{ id: number; name: string }>(
		(db as any).query.users.findFirst({
			where: (
				fields: typeof users,
				{ eq }: { eq: (left: unknown, right: unknown) => unknown }
			) => eq(fields.id, 1),
		})
	)

	assert.deepEqual(many, [{ __proto__: null, id: 1, name: 'Twilight Sparkle' }])
	assert.deepEqual(first, { __proto__: null, id: 1, name: 'Twilight Sparkle' })
	assert.deepEqual(firstViaGet, { __proto__: null, id: 1, name: 'Twilight Sparkle' })
	assert.equal(executedQueries.length, 3)
	assert.match(
		executedQueries[0] ?? '',
		/^select `users`\.`id` as `__ydb_c0`, `users`\.`name` as `__ydb_c1` from `users` `users`$/
	)
	assert.match(
		executedQueries[1] ?? '',
		/^select `users`\.`id` as `__ydb_c0`, `users`\.`name` as `__ydb_c1` from `users` `users` where `users`\.`id` = \$p0 limit \$p1$/
	)
	assert.match(
		executedQueries[2] ?? '',
		/^select `users`\.`id` as `__ydb_c0`, `users`\.`name` as `__ydb_c1` from `users` `users` where `users`\.`id` = \$p0 limit \$p1$/
	)
})

test('findMany and findFirst return null-prototype rows through nested relations', async () => {
	let db = drizzle(
		async (query) => {
			let aliases = Array.from(query.matchAll(/ as `([^`]+)`/g), (match) => match[1]!)
			let values = query.includes('from `posts`')
				? [10, 1, 'Friendship lesson']
				: [1, 'Twilight Sparkle']
			return {
				rows: [Object.fromEntries(aliases.map((alias, index) => [alias, values[index]]))],
			}
		},
		{ schema }
	)

	let many = await db.query.users.findMany({ with: { posts: { with: { author: true } } } })
	let first = await db.query.users.findFirst({ with: { posts: { with: { author: true } } } })

	let expected = {
		__proto__: null,
		id: 1,
		name: 'Twilight Sparkle',
		posts: [
			{
				__proto__: null,
				id: 10,
				authorId: 1,
				title: 'Friendship lesson',
				author: { __proto__: null, id: 1, name: 'Twilight Sparkle' },
			},
		],
	}
	assert.deepEqual(many, [expected])
	assert.deepEqual(first, expected)
	for (let row of [many[0]!, first!]) {
		assert.equal(Object.getPrototypeOf(row), null)
		assert.equal(Object.getPrototypeOf(row.posts[0]), null)
		assert.equal(Object.getPrototypeOf(row.posts[0]!.author), null)
	}
})
