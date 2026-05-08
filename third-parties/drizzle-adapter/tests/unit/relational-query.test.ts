import { test } from 'vitest'
import assert from 'node:assert/strict'
import {
	createTableRelationsHelpers,
	extractTablesRelationalConfig,
	relations,
} from 'drizzle-orm/relations'
import { YdbRelationalQueryBuilder } from '../../src/ydb-core/query-builders/index.ts'
import { dialect, posts, users } from '../helpers/unit-basic.ts'

function buildObjectRows(sqlText: string, rowValues: unknown[][]): Array<Record<string, unknown>> {
	let aliases = Array.from(sqlText.matchAll(/ as `([^`]+)`/g), (match) => match[1]!)
	return rowValues.map((values) =>
		Object.fromEntries(aliases.map((alias, index) => [alias, values[index]]))
	)
}

function createRelationalSession(executedSql: string[]) {
	return {
		prepareQuery(query: any) {
			let built =
				'sql' in query && Array.isArray(query.params) ? query : dialect.sqlToQuery(query)
			executedSql.push(built.sql)

			return {
				getQuery() {
					return built
				},
				async execute() {
					if (
						built.sql.includes('from `users` `posts_author`') ||
						built.sql.includes('from `users` `users_posts_author`')
					) {
						return buildObjectRows(built.sql, [[1, 'Pinkie Pie']])
					}

					if (built.sql.includes('from `posts` `users_posts`')) {
						return buildObjectRows(built.sql, [
							[10, 'Cupcakes', 1],
							[11, 'Sonic Rainboom', 1],
						])
					}

					if (built.sql.includes('from `users` `users`')) {
						if (built.sql.includes('offset')) {
							return buildObjectRows(built.sql, [
								[1, 'Pinkie Pie', undefined, undefined],
								[2, 'Rainbow Dash', undefined, undefined],
							])
						}

						if (built.sql.includes('limit')) {
							return buildObjectRows(built.sql, [
								[1, 'Pinkie Pie', undefined, undefined],
							])
						}

						return buildObjectRows(built.sql, [
							[1, 'Pinkie Pie', undefined, undefined],
							[2, 'Rainbow Dash', undefined, undefined],
						])
					}

					if (built.sql.includes('from `posts` `posts`')) {
						return buildObjectRows(built.sql, [[10, 'Cupcakes', 1]])
					}

					return []
				},
				async values() {
					return []
				},
			}
		},
	} as any
}

function createChunkedRelationalSession(
	executedQueries: Array<{ sql: string; params: unknown[] }>
) {
	return {
		prepareQuery(query: any) {
			let built =
				'sql' in query && Array.isArray(query.params) ? query : dialect.sqlToQuery(query)
			executedQueries.push({ sql: built.sql, params: [...built.params] })

			return {
				getQuery() {
					return built
				},
				async execute() {
					if (built.sql.includes('from `users` `users`')) {
						return buildObjectRows(
							built.sql,
							Array.from({ length: 260 }, (_, index) => [
								index + 1,
								`User ${index + 1}`,
							])
						)
					}

					if (built.sql.includes('from `posts` `users_posts`')) {
						return buildObjectRows(
							built.sql,
							built.params.map((userId) => [
								Number(userId) * 10,
								`Post ${String(userId)}`,
								userId,
							])
						)
					}

					return []
				},
				async values() {
					return []
				},
			}
		},
	} as any
}

let schema = {
	users,
	posts,
	usersRelations: relations(users, ({ many }) => ({
		posts: many(posts),
	})),
	postsRelations: relations(posts, ({ one }) => ({
		author: one(users, {
			fields: [posts.userId],
			references: [users.id],
		}),
	})),
}

test('relational builder handles flat findMany/findFirst queries', async () => {
	let executedSql: string[] = []
	let tablesConfig = extractTablesRelationalConfig(schema, createTableRelationsHelpers)
	let relational = new YdbRelationalQueryBuilder(
		schema,
		tablesConfig.tables as any,
		tablesConfig.tableNamesMap,
		users,
		(tablesConfig.tables as any).users,
		dialect,
		createRelationalSession(executedSql)
	)

	let many = await relational
		.findMany({
			columns: { id: true, name: true },
			where: (fields, { eq }) => eq(fields['id'], 1),
			orderBy: (fields, { desc }) => desc(fields['name']),
			limit: 5,
			offset: 2,
		})
		.execute()
	let first = await relational
		.findFirst({
			where: (fields, { eq }) => eq(fields['id'], 1),
		})
		.execute()

	assert.deepEqual(many, [
		{ id: 1, name: 'Pinkie Pie' },
		{ id: 2, name: 'Rainbow Dash' },
	])
	assert.deepEqual(first, {
		id: 1,
		name: 'Pinkie Pie',
		createdAt: undefined,
		updatedAt: undefined,
	})
	assert.match(
		executedSql[0] ?? '',
		/^select `users`\.`id` as `__ydb_c0`, `users`\.`name` as `__ydb_c1` from `users` `users` where `users`\.`id` = \$p0 order by `users`\.`name` desc limit \$p1 offset \$p2$/
	)
	assert.match(
		executedSql[1] ?? '',
		/^select `users`\.`id` as `__ydb_c0`, `users`\.`name` as `__ydb_c1`, `users`\.`created_at` as `__ydb_c2`, `users`\.`updated_at` as `__ydb_c3` from `users` `users` where `users`\.`id` = \$p0 limit \$p1$/
	)
})

test('relational builder hydrates many/one relations through schema metadata', async () => {
	let executedSql: string[] = []
	let tablesConfig = extractTablesRelationalConfig(schema, createTableRelationsHelpers)
	let usersRelational = new YdbRelationalQueryBuilder(
		schema,
		tablesConfig.tables as any,
		tablesConfig.tableNamesMap,
		users,
		(tablesConfig.tables as any).users,
		dialect,
		createRelationalSession(executedSql)
	)
	let postsRelational = new YdbRelationalQueryBuilder(
		schema,
		tablesConfig.tables as any,
		tablesConfig.tableNamesMap,
		posts,
		(tablesConfig.tables as any).posts,
		dialect,
		createRelationalSession(executedSql)
	)

	let usersWithPosts = await usersRelational
		.findMany({
			columns: { id: true, name: true },
			with: {
				posts: {
					columns: { id: true, title: true },
				},
			},
		})
		.execute()
	let postsWithAuthor = await postsRelational
		.findMany({
			columns: { id: true, title: true },
			with: {
				author: {
					columns: { id: true, name: true },
				},
			},
		})
		.execute()

	assert.deepEqual(usersWithPosts, [
		{
			id: 1,
			name: 'Pinkie Pie',
			posts: [
				{ id: 10, title: 'Cupcakes' },
				{ id: 11, title: 'Sonic Rainboom' },
			],
		},
		{
			id: 2,
			name: 'Rainbow Dash',
			posts: [],
		},
	])
	assert.deepEqual(postsWithAuthor, [
		{
			id: 10,
			title: 'Cupcakes',
			author: {
				id: 1,
				name: 'Pinkie Pie',
			},
		},
	])
	assert.ok(executedSql.some((query) => query.includes('from `posts` `users_posts`')))
	assert.ok(executedSql.some((query) => query.includes('from `users` `posts_author`')))
	assert.ok(executedSql.some((query) => query.includes('from `users` `users`')))
})

test('relational builder chunks relation filters for large parent sets', async () => {
	let executedQueries: Array<{ sql: string; params: unknown[] }> = []
	let tablesConfig = extractTablesRelationalConfig(schema, createTableRelationsHelpers)
	let usersRelational = new YdbRelationalQueryBuilder(
		schema,
		tablesConfig.tables as any,
		tablesConfig.tableNamesMap,
		users,
		(tablesConfig.tables as any).users,
		dialect,
		createChunkedRelationalSession(executedQueries)
	)

	let rows = await usersRelational
		.findMany({
			columns: { id: true, name: true },
			with: {
				posts: {
					columns: { id: true, title: true },
				},
			},
		})
		.execute()
	let relationQueries = executedQueries.filter(({ sql }) =>
		sql.includes('from `posts` `users_posts`')
	)

	assert.equal(rows.length, 260)
	assert.deepEqual(rows[0], {
		id: 1,
		name: 'User 1',
		posts: [{ id: 10, title: 'Post 1' }],
	})
	assert.deepEqual(rows[259], {
		id: 260,
		name: 'User 260',
		posts: [{ id: 2600, title: 'Post 260' }],
	})
	assert.equal(relationQueries.length, 2)
	assert.ok(relationQueries.every(({ params }) => params.length <= 256))
	assert.deepEqual(
		relationQueries.map(({ params }) => params.length),
		[256, 4]
	)
})
