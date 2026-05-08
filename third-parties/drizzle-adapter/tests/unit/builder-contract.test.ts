import { test } from 'vitest'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import {
	YdbDeleteBuilder,
	YdbInsertBuilder,
	YdbReplaceBuilder,
	YdbSelectBuilder,
	YdbUpdateBuilder,
	YdbUpsertBuilder,
} from '../../src/ydb-core/query-builders/index.ts'
import { createMockSession, users } from '../helpers/unit-basic.ts'

test('builders', async () => {
	let { session, prepareCalls } = createMockSession()

	let selectBuilder = new YdbSelectBuilder(session).from(users).where(eq(users.id, 7))
	let insertBuilder = new YdbInsertBuilder(users, session).values({ id: 1, name: 'Twilight' })
	let upsertBuilder = new YdbUpsertBuilder(users, session).values({ id: 2, name: 'Starlight' })
	let replaceBuilder = new YdbReplaceBuilder(users, session).values({ id: 3, name: 'Fluttershy' })
	let updateBuilder = new YdbUpdateBuilder(users, session)
		.set({ name: 'Rainbow' })
		.where(eq(users.id, 1))
	let deleteBuilder = new YdbDeleteBuilder(users, session).where(eq(users.id, 1))

	assert.equal(
		selectBuilder.toSQL().sql,
		'select `users`.`id`, `users`.`name`, `users`.`created_at`, `users`.`updated_at` from `users` where `users`.`id` = $p0'
	)
	assert.equal(
		insertBuilder.toSQL().sql,
		'insert into `users` (`id`, `name`, `created_at`, `updated_at`) values ($p0, $p1, $p2, $p3)'
	)
	assert.equal(upsertBuilder.toSQL().sql, 'upsert into `users` (`id`, `name`) values ($p0, $p1)')
	assert.equal(
		replaceBuilder.toSQL().sql,
		'replace into `users` (`id`, `name`, `created_at`, `updated_at`) values ($p0, $p1, $p2, $p3)'
	)
	assert.equal(
		updateBuilder.toSQL().sql,
		'update `users` set `name` = $p0, `updated_at` = $p1 where `users`.`id` = $p2'
	)
	assert.equal(deleteBuilder.toSQL().sql, 'delete from `users` where `users`.`id` = $p0')

	await selectBuilder.prepare('sel_users').execute()
	await insertBuilder.prepare('ins_users').execute()
	await upsertBuilder.prepare('ups_users').execute()
	await replaceBuilder.prepare('rep_users').execute()
	await updateBuilder.prepare('upd_users').execute()
	await deleteBuilder.prepare('del_users').execute()

	assert.deepEqual(
		prepareCalls.map(({ name, isResponseInArrayMode }) => ({ name, isResponseInArrayMode })),
		[
			{ name: 'sel_users', isResponseInArrayMode: true },
			{ name: 'ins_users', isResponseInArrayMode: false },
			{ name: 'ups_users', isResponseInArrayMode: false },
			{ name: 'rep_users', isResponseInArrayMode: false },
			{ name: 'upd_users', isResponseInArrayMode: false },
			{ name: 'del_users', isResponseInArrayMode: false },
		]
	)

	let executedSelect = (await selectBuilder.execute()) as unknown as { prepared: string }
	let executedInsert = (await insertBuilder.execute()) as unknown as { prepared: string }
	let executedUpsert = (await upsertBuilder.execute()) as unknown as { prepared: string }
	let executedReplace = (await replaceBuilder.execute()) as unknown as { prepared: string }
	let executedUpdate = (await updateBuilder.execute()) as unknown as { prepared: string }
	let executedDelete = (await deleteBuilder.execute()) as unknown as { prepared: string }

	assert.match(executedSelect.prepared, /^select /)
	assert.match(executedInsert.prepared, /^insert into /)
	assert.match(executedUpsert.prepared, /^upsert into /)
	assert.match(executedReplace.prepared, /^replace into /)
	assert.match(executedUpdate.prepared, /^update /)
	assert.match(executedDelete.prepared, /^delete from /)
})

test('returning mutation builders prepare in array mode', async () => {
	let { session, prepareCalls } = createMockSession()

	await new YdbInsertBuilder(users, session)
		.values({ id: 1, name: 'Twilight' })
		.returning({ id: users.id, name: users.name })
		.prepare('ins_ret')
		.execute()
	await new YdbUpsertBuilder(users, session)
		.values({ id: 2, name: 'Starlight' })
		.returning({ id: users.id })
		.prepare('ups_ret')
		.execute()
	await new YdbUpdateBuilder(users, session)
		.set({ name: 'Rainbow' })
		.returning({ id: users.id })
		.prepare('upd_ret')
		.execute()
	await new YdbDeleteBuilder(users, session)
		.where(eq(users.id, 1))
		.returning({ id: users.id })
		.prepare('del_ret')
		.execute()

	assert.deepEqual(
		prepareCalls.map(({ name, isResponseInArrayMode, fields }) => ({
			name,
			isResponseInArrayMode,
			fieldCount: Array.isArray(fields) ? fields.length : 0,
		})),
		[
			{ name: 'ins_ret', isResponseInArrayMode: true, fieldCount: 2 },
			{ name: 'ups_ret', isResponseInArrayMode: true, fieldCount: 1 },
			{ name: 'upd_ret', isResponseInArrayMode: true, fieldCount: 1 },
			{ name: 'del_ret', isResponseInArrayMode: true, fieldCount: 1 },
		]
	)
})

test('builders reject invalid state', () => {
	let { session } = createMockSession()

	assert.throws(
		() => new YdbSelectBuilder(session).getSQL(),
		/Missing table in select\(\)\.from\(\)/
	)
	assert.throws(() => new YdbInsertBuilder(users, session).getSQL(), /Insert values are missing/)
	assert.throws(
		() => new YdbInsertBuilder(users, session).values([]).getSQL(),
		/Insert values are empty/
	)
	assert.throws(() => new YdbUpsertBuilder(users, session).getSQL(), /Upsert values are missing/)
	assert.throws(
		() => new YdbReplaceBuilder(users, session).values([]).getSQL(),
		/Replace values are empty/
	)
	assert.throws(() => new YdbUpdateBuilder(users, session).getSQL(), /Update values are missing/)
	assert.throws(
		() => new YdbSelectBuilder(session).from(users).limit(-1),
		/YDB limit\(\) expects a non-negative finite number/
	)
	assert.throws(
		() => new YdbSelectBuilder(session).from(users).offset(-1),
		/YDB offset\(\) expects a non-negative finite number/
	)
	assert.throws(
		() => new YdbSelectBuilder(session).distinct().distinctOn(users.id),
		/cannot combine distinct\(\) and distinctOn\(\)/
	)
	assert.throws(
		() => new YdbSelectBuilder(session).distinctOn(users.id).distinct(),
		/cannot combine distinct\(\) and distinctOn\(\)/
	)
})
