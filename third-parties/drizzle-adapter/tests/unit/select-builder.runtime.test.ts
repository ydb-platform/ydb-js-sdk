import { test } from 'vitest'
import assert from 'node:assert/strict'
import { desc, eq } from 'drizzle-orm'
import { YdbSelectBuilder } from '../../src/ydb-core/query-builders/index.ts'
import { dialect, posts, users } from '../helpers/unit-basic.ts'

test('select builder maps joins and advanced queries', async () => {
	let executedSql: string[] = []
	let advancedSession = {
		prepareQuery(
			query: any,
			_fields: unknown,
			_name?: string,
			_isResponseInArrayMode = false,
			customResultMapper?: (rows: unknown[][]) => unknown
		) {
			let built =
				'sql' in query && Array.isArray(query.params) ? query : dialect.sqlToQuery(query)
			executedSql.push(built.sql)

			return {
				getQuery() {
					return built
				},
				async execute() {
					let rows = built.sql.includes('__ydb_row_number')
						? [
								[1, 'Zecora'],
								[2, 'Rainbow Dash'],
							]
						: [
								[1, 'Twilight Sparkle', 100, 200, 11, 1, 'Lesson Zero'],
								[2, 'Pinkie Pie', 100, 200, null, null, null],
							]

					return customResultMapper ? customResultMapper(rows) : rows
				},
			}
		},
	} as any

	let joinedRows = (await new YdbSelectBuilder(advancedSession)
		.from(users)
		.leftJoin(posts, eq(users.id, posts.userId))
		.orderBy(users.id, posts.id)
		.execute()) as Array<Record<string, unknown>>

	let distinctOnRows = (await new YdbSelectBuilder(advancedSession, {
		userId: posts.userId,
		title: posts.title,
	})
		.from(posts)
		.distinctOn(posts.userId)
		.orderBy(posts.userId, desc(posts.title))
		.execute()) as Array<{ userId: number; title: string }>

	assert.deepEqual(joinedRows, [
		{
			users: {
				id: 1,
				name: 'Twilight Sparkle',
				createdAt: 100,
				updatedAt: 200,
			},
			posts: {
				id: 11,
				userId: 1,
				title: 'Lesson Zero',
			},
		},
		{
			users: {
				id: 2,
				name: 'Pinkie Pie',
				createdAt: 100,
				updatedAt: 200,
			},
			posts: null,
		},
	])
	assert.deepEqual(distinctOnRows, [
		{ userId: 1, title: 'Zecora' },
		{ userId: 2, title: 'Rainbow Dash' },
	])
	assert.match(
		executedSql[0] ?? '',
		/^select `users`\.`id` as `__ydb_f0`, `users`\.`name` as `__ydb_f1`, `users`\.`created_at` as `__ydb_f2`, `users`\.`updated_at` as `__ydb_f3`, `posts`\.`id` as `__ydb_f4`, `posts`\.`user_id` as `__ydb_f5`, `posts`\.`title` as `__ydb_f6` from `users` left join `posts` on `users`\.`id` = `posts`\.`user_id` order by `users`\.`id`, `posts`\.`id`$/
	)
	assert.match(executedSql[1] ?? '', /row_number\(\) over \(/)
})
