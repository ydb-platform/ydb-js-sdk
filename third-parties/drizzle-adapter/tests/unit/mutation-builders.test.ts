import { test } from 'vitest'
import assert from 'node:assert/strict'
import { eq, sql as yql } from 'drizzle-orm'
import { integer, text, ydbTable } from '../../src/index.ts'
import {
	YdbBatchDeleteBuilder,
	YdbBatchUpdateBuilder,
	YdbDeleteBuilder,
	YdbInsertBuilder,
	YdbReplaceBuilder,
	YdbUpdateBuilder,
	YdbUpsertBuilder,
} from '../../src/ydb-core/query-builders/index.ts'
import { dialect, session, users } from '../helpers/unit-basic.ts'

function toQuery(builder: { getSQL(): any }) {
	return dialect.sqlToQuery(builder.getSQL())
}

test('delete sql', () => {
	let query = toQuery(new YdbDeleteBuilder(users, session).where(eq(users.id, 7)))

	assert.equal(query.sql, 'delete from `users` where `users`.`id` = $p0')
	assert.deepEqual(query.params, [7])
})

test('delete returning', () => {
	let query = toQuery(
		new YdbDeleteBuilder(users, session)
			.where(eq(users.id, 7))
			.returning({ id: users.id, name: users.name })
	)

	assert.equal(query.sql, 'delete from `users` where `users`.`id` = $p0 returning `id`, `name`')
	assert.deepEqual(query.params, [7])
})

test('delete on select sql', () => {
	let keyedUsers = ydbTable('keyed_users', {
		id: integer('id').notNull().primaryKey(),
		name: text('name').notNull(),
	})

	let query = toQuery(
		new YdbDeleteBuilder(keyedUsers, session, dialect)
			.on((qb) =>
				qb
					.select({
						id: keyedUsers.id,
					})
					.from(keyedUsers)
					.where(eq(keyedUsers.id, 1))
			)
			.returning({ id: keyedUsers.id })
	)

	assert.equal(
		query.sql,
		'delete from `keyed_users` on select `keyed_users`.`id` from `keyed_users` where `keyed_users`.`id` = $p0 returning `id`'
	)
	assert.deepEqual(query.params, [1])
})

test('delete on validates target columns and primary key', () => {
	let keyedUsers = ydbTable('keyed_users', {
		id: integer('id').notNull().primaryKey(),
		name: text('name').notNull(),
	})

	assert.throws(
		() =>
			new YdbDeleteBuilder(keyedUsers, session, dialect).on((qb) =>
				qb
					.select({
						name: keyedUsers.name,
					})
					.from(keyedUsers)
			),
		/requires primary key column "id"/
	)

	assert.throws(
		() =>
			new YdbDeleteBuilder(keyedUsers, session, dialect).on((qb) =>
				qb
					.select({
						id: keyedUsers.id,
						nope: keyedUsers.name,
					})
					.from(keyedUsers)
			),
		/selected field "nope"/
	)

	assert.throws(
		() =>
			new YdbDeleteBuilder(keyedUsers, session, dialect)
				.on((qb) =>
					qb
						.select({
							id: keyedUsers.id,
						})
						.from(keyedUsers)
				)
				.where(eq(keyedUsers.id, 1)),
		/does not support where/
	)

	assert.throws(
		() =>
			new YdbDeleteBuilder(keyedUsers, session, dialect)
				.on((qb) =>
					qb
						.select({
							id: keyedUsers.id,
						})
						.from(keyedUsers)
				)
				.using(yql.identifier('posts')),
		/does not support using/
	)
})

test('insert defaults', () => {
	let query = toQuery(new YdbInsertBuilder(users, session).values({ id: 1, name: 'Pinkie Pie' }))

	assert.equal(
		query.sql,
		'insert into `users` (`id`, `name`, `created_at`, `updated_at`) values ($p0, $p1, $p2, $p3)'
	)
	assert.deepEqual(query.params, [1, 'Pinkie Pie', 100, 200])
})

test('insert order', () => {
	let query = toQuery(
		new YdbInsertBuilder(users, session).values([
			{ id: 1, name: 'Twilight Sparkle', createdAt: 10, updatedAt: 11 },
			{ name: 'Rainbow Dash', id: 2, updatedAt: 22 },
		])
	)

	assert.equal(
		query.sql,
		'insert into `users` (`id`, `name`, `created_at`, `updated_at`) values ($p0, $p1, $p2, $p3), ($p4, $p5, $p6, $p7)'
	)
	assert.deepEqual(query.params, [1, 'Twilight Sparkle', 10, 11, 2, 'Rainbow Dash', 100, 22])
})

test('insert rejects unknown', () => {
	assert.throws(
		() =>
			toQuery(
				new YdbInsertBuilder(users, session).values({
					id: 1,
					name: 'Applejack',
					nope: true,
				} as any)
			),
		/Unknown column "nope" in insert\(\)/
	)
})

test('insert returning', () => {
	let allColumns = toQuery(
		new YdbInsertBuilder(users, session).values({ id: 1, name: 'Pinkie Pie' }).returning()
	)

	assert.equal(
		allColumns.sql,
		'insert into `users` (`id`, `name`, `created_at`, `updated_at`) values ($p0, $p1, $p2, $p3) returning `id`, `name`, `created_at`, `updated_at`'
	)
	assert.deepEqual(allColumns.params, [1, 'Pinkie Pie', 100, 200])

	let selectedColumns = toQuery(
		new YdbInsertBuilder(users, session)
			.values({ id: 2, name: 'Rarity' })
			.returning({ id: users.id, label: yql<string>`Upper(${users.name})`.as('label') })
	)

	assert.equal(
		selectedColumns.sql,
		'insert into `users` (`id`, `name`, `created_at`, `updated_at`) values ($p0, $p1, $p2, $p3) returning `id`, Upper(`users`.`name`) as `label`'
	)
	assert.deepEqual(selectedColumns.params, [2, 'Rarity', 100, 200])
})

test('native upsert values use provided columns', () => {
	let query = toQuery(
		new YdbUpsertBuilder(users, session)
			.values({ id: 1, name: 'Starlight' })
			.returning({ id: users.id, name: users.name })
	)

	assert.equal(
		query.sql,
		'upsert into `users` (`id`, `name`) values ($p0, $p1) returning `id`, `name`'
	)
	assert.deepEqual(query.params, [1, 'Starlight'])
})

test('native upsert rejects inconsistent value columns', () => {
	assert.throws(
		() =>
			toQuery(
				new YdbUpsertBuilder(users, session).values([
					{ id: 1, name: 'Twilight' },
					{ id: 2 },
				])
			),
		/same columns/
	)
})

test('native replace values', () => {
	let query = toQuery(new YdbReplaceBuilder(users, session).values({ id: 1, name: 'Fluttershy' }))

	assert.equal(
		query.sql,
		'replace into `users` (`id`, `name`, `created_at`, `updated_at`) values ($p0, $p1, $p2, $p3)'
	)
	assert.deepEqual(query.params, [1, 'Fluttershy', 100, 200])
})

test('native replace returning is explicitly unsupported', () => {
	assert.throws(
		() =>
			new YdbReplaceBuilder(users, session).values({ id: 1, name: 'Fluttershy' }).returning(),
		/not documented or supported/
	)
})

test('update onUpdate', () => {
	let query = toQuery(
		new YdbUpdateBuilder(users, session).set({ name: 'Fluttershy' }).where(eq(users.id, 5))
	)

	assert.equal(
		query.sql,
		'update `users` set `name` = $p0, `updated_at` = $p1 where `users`.`id` = $p2'
	)
	assert.deepEqual(query.params, ['Fluttershy', 200, 5])
})

test('update returning', () => {
	let query = toQuery(
		new YdbUpdateBuilder(users, session)
			.set({ name: 'Fluttershy' })
			.where(eq(users.id, 5))
			.returning({ id: users.id, name: users.name })
	)

	assert.equal(
		query.sql,
		'update `users` set `name` = $p0, `updated_at` = $p1 where `users`.`id` = $p2 returning `id`, `name`'
	)
	assert.deepEqual(query.params, ['Fluttershy', 200, 5])
})

test('update on select sql', () => {
	let keyedUsers = ydbTable('keyed_users', {
		id: integer('id').notNull().primaryKey(),
		name: text('name').notNull(),
	})

	let query = toQuery(
		new YdbUpdateBuilder(keyedUsers, session, dialect)
			.on((qb) =>
				qb
					.select({
						id: keyedUsers.id,
						name: yql<string>`${'updated'}`.as('name'),
					})
					.from(keyedUsers)
					.where(eq(keyedUsers.id, 1))
			)
			.returning({ id: keyedUsers.id, name: keyedUsers.name })
	)

	assert.equal(
		query.sql,
		'update `keyed_users` on select `keyed_users`.`id`, $p0 as `name` from `keyed_users` where `keyed_users`.`id` = $p1 returning `id`, `name`'
	)
	assert.deepEqual(query.params, ['updated', 1])
})

test('update on validates target columns and primary key', () => {
	let keyedUsers = ydbTable('keyed_users', {
		id: integer('id').notNull().primaryKey(),
		name: text('name').notNull(),
	})

	assert.throws(
		() =>
			new YdbUpdateBuilder(keyedUsers, session, dialect).on((qb) =>
				qb
					.select({
						name: keyedUsers.name,
					})
					.from(keyedUsers)
			),
		/requires primary key column "id"/
	)

	assert.throws(
		() =>
			new YdbUpdateBuilder(keyedUsers, session, dialect).on((qb) =>
				qb
					.select({
						id: keyedUsers.id,
						nope: keyedUsers.name,
					})
					.from(keyedUsers)
			),
		/selected field "nope"/
	)

	assert.throws(
		() =>
			new YdbUpdateBuilder(keyedUsers, session, dialect)
				.on((qb) =>
					qb
						.select({
							id: keyedUsers.id,
							name: keyedUsers.name,
						})
						.from(keyedUsers)
				)
				.where(eq(keyedUsers.id, 1)),
		/does not support where/
	)
})

test('update rejects unknown', () => {
	assert.throws(
		() => toQuery(new YdbUpdateBuilder(users, session).set({ nope: true } as any)),
		/Unknown column "nope" in update\(\)/
	)
})

test('update rejects empty', () => {
	let tableWithoutUpdateHooks = ydbTable('plain_users', {
		id: integer('id').notNull(),
		name: text('name').notNull(),
	})

	assert.throws(
		() => toQuery(new YdbUpdateBuilder(tableWithoutUpdateHooks, session).set({})),
		/Update values are empty/
	)
})

test('batch update and delete sql', () => {
	let updateQuery = toQuery(
		new YdbBatchUpdateBuilder(users, session).set({ name: 'Applejack' }).where(eq(users.id, 1))
	)
	let deleteQuery = toQuery(new YdbBatchDeleteBuilder(users, session).where(eq(users.id, 2)))

	assert.equal(
		updateQuery.sql,
		'batch update `users` set `name` = $p0, `updated_at` = $p1 where `users`.`id` = $p2'
	)
	assert.deepEqual(updateQuery.params, ['Applejack', 200, 1])
	assert.equal(deleteQuery.sql, 'batch delete from `users` where `users`.`id` = $p0')
	assert.deepEqual(deleteQuery.params, [2])
})

test('batch update and delete reject unsupported mutation clauses', () => {
	assert.throws(() => new YdbBatchUpdateBuilder(users, session).returning(), /not supported/)
	assert.throws(() => new YdbBatchUpdateBuilder(users, session).on(), /not supported/)
	assert.throws(() => new YdbBatchDeleteBuilder(users, session).returning(), /not supported/)
	assert.throws(() => new YdbBatchDeleteBuilder(users, session).using(), /not supported/)
	assert.throws(() => new YdbBatchDeleteBuilder(users, session).on(), /not supported/)
})
