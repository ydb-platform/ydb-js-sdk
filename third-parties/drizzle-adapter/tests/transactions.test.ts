import { expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import { TransactionRollbackError } from 'drizzle-orm/errors'
import { createLiveContext } from './helpers/context.ts'
import { users, usersTableName } from './helpers/schema.ts'

let live = createLiveContext()

test('runs transactions against live YDB', async (t) => {
	if (!live.requireLiveYdb(t)) return
	live.describeDbChange(
		t,
		'commit one inserted row inside a transaction, then execute a rollback path and verify only committed data remains'
	)
	let committedId = live.baseIntId + 301
	let rolledBackId = live.baseIntId + 302

	live.liveQueryLog.length = 0
	live.log('tx', committedId, rolledBackId)
	await live.deleteUserRows([committedId, rolledBackId])

	try {
		await live.db.transaction(
			async (tx) => {
				await tx.insert(users).values({ id: committedId, name: 'starlight glimmer' })

				let insideTxRow = await (tx as any).query.users.findFirst({
					where: (
						fields: typeof users,
						operators: { eq: (left: unknown, right: unknown) => unknown }
					) => operators.eq(fields.id, committedId),
				})

				expect(insideTxRow).toEqual({ id: committedId, name: 'starlight glimmer' })
			},
			{ accessMode: 'read write', idempotent: false }
		)

		let committedRow = await (live.db as any).query.users.findFirst({
			where: (
				fields: typeof users,
				operators: { eq: (left: unknown, right: unknown) => unknown }
			) => operators.eq(fields.id, committedId),
		})

		expect(committedRow).toEqual({ id: committedId, name: 'starlight glimmer' })

		await expect(
			live.db.transaction(
				async (tx) => {
					await tx.insert(users).values({ id: rolledBackId, name: 'tempest shadow' })
					tx.rollback()
				},
				{ accessMode: 'read write' }
			)
		).rejects.toBeInstanceOf(TransactionRollbackError)

		let rolledBackRows = (await live.db
			.select()
			.from(users)
			.where(eq(users.id, rolledBackId))) as Array<{
			id: number
			name: string
		}>

		expect(rolledBackRows).toEqual([])
		expect(
			live.liveQueryLog.some(({ query }) =>
				query.includes(`insert into \`${usersTableName}\``)
			)
		).toBe(true)
		expect(
			live.liveQueryLog.some(({ query }) => query.includes(`from \`${usersTableName}\``))
		).toBe(true)
	} finally {
		await live.deleteUserRows([committedId, rolledBackId])
	}
})
