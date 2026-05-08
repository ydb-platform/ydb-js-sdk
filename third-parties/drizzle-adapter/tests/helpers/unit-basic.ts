import { integer, text, ydbTable } from '../../src/index.ts'
import { YdbDialect } from '../../src/ydb/dialect.ts'

export let dialect = new YdbDialect()
export let session = {} as any

export let users = ydbTable('users', {
	id: integer('id').notNull(),
	name: text('name').notNull(),
	createdAt: integer('created_at').$defaultFn(() => 100),
	updatedAt: integer('updated_at').$onUpdateFn(() => 200),
})

export let posts = ydbTable('posts', {
	id: integer('id').notNull(),
	userId: integer('user_id').notNull(),
	title: text('title').notNull(),
})

export function createMockSession() {
	let prepareCalls: Array<{
		name?: string
		isResponseInArrayMode: boolean
		query: { sql: string; params: unknown[]; typings?: unknown[] }
		fields: unknown
	}> = []

	return {
		prepareCalls,
		session: {
			prepareQuery(
				query: any,
				fields: unknown,
				name?: string,
				isResponseInArrayMode = false
			) {
				let built =
					'sql' in query && Array.isArray(query.params)
						? query
						: dialect.sqlToQuery(query)
				prepareCalls.push({ name, isResponseInArrayMode, query: built, fields })

				return {
					getQuery() {
						return built
					},
					async execute() {
						return { prepared: built.sql, params: built.params, name, fields }
					},
				}
			},
		} as any,
	}
}
