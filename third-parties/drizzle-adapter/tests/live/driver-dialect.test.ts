import { test } from 'vitest'
import assert from 'node:assert/strict'
import { createTableRelationsHelpers, extractTablesRelationalConfig } from 'drizzle-orm/relations'
import { eq, sql as yql } from 'drizzle-orm'
import { WithSubquery } from 'drizzle-orm/subquery'
import { YdbDriver } from '../../src/index.ts'
import { YdbDialect } from '../../src/ydb/dialect.ts'
import { orderSelectedFields } from '../../src/ydb-core/result-mapping.ts'
import { createLiveContext } from './helpers/context.ts'
import { liveSchema, posts, users } from './helpers/schema.ts'

let live = createLiveContext()

test('driver execute and transaction preserve direct result metadata on live YDB', async (t) => {
	if (!live.requireLiveYdb(t)) return
	live.describeDbChange(
		t,
		'read-only direct driver queries; validates result metadata and transaction executor plumbing'
	)

	let dialect = new YdbDialect()
	let driver = live.db.$client as YdbDriver
	let query = dialect.sqlToQuery(yql`select ${1} as ${yql.identifier('value')}`)

	let executeResult = await driver.execute(query.sql, query.params, 'execute', {
		typings: query.typings,
	})
	let txRows = await driver.transaction(
		async (tx) => {
			let txResult = await tx.execute(query.sql, query.params, 'execute', {
				typings: query.typings,
			})

			return txResult.rows
		},
		{ accessMode: 'read only' }
	)

	assert.deepEqual(executeResult.rows, [{ value: 1 }])
	assert.equal(executeResult.rowCount, 1)
	assert.equal(executeResult.command, 'execute')
	assert.deepEqual(executeResult.meta, {
		arrayMode: false,
		typings: ['none'],
	})
	assert.deepEqual(txRows, [{ value: 1 }])
})

test('dialect helper queries execute on live YDB', async (t) => {
	if (!live.requireLiveYdb(t)) return
	live.describeDbChange(
		t,
		'insert one user through dialect SQL builders, verify CTE and flat relational SQL, update and delete it again'
	)

	let dialect = new YdbDialect()
	let driver = live.db.$client as YdbDriver
	let userId = live.baseIntId + 401

	await live.deleteUserRows([userId])

	try {
		let insertQuery = dialect.sqlToQuery(
			dialect.buildInsertQuery({
				table: users,
				values: [{ id: userId, name: 'Starlight Glimmer' }],
			})
		)

		await driver.execute(insertQuery.sql, insertQuery.params, 'execute', {
			typings: insertQuery.typings,
		})

		let cte = new WithSubquery(
			yql`select ${userId} as ${yql.identifier('id')}, ${'Starlight Glimmer'} as ${yql.identifier('name')}`,
			{ id: users.id, name: users.name } as any,
			'seed_user'
		)
		let cteQuery = dialect.sqlToQuery(
			yql`${dialect.buildWithCTE([cte])}select * from ${dialect.buildFromTable(cte)}`
		)
		let cteResult = await driver.execute(cteQuery.sql, cteQuery.params, 'execute', {
			typings: cteQuery.typings,
		})

		assert.deepEqual(cteResult.rows, [{ id: userId, name: 'Starlight Glimmer' }])

		let tablesConfig = extractTablesRelationalConfig(liveSchema, createTableRelationsHelpers)
		let relationalQuery = dialect.buildRelationalQueryWithoutPK({
			fullSchema: liveSchema,
			schema: tablesConfig.tables as any,
			tableNamesMap: tablesConfig.tableNamesMap,
			table: users,
			tableConfig: (tablesConfig.tables as any).users,
			queryConfig: {
				columns: { id: true, name: true },
				where: (fields, operators) => operators.eq(fields['id'], userId),
				limit: 1,
			},
			tableAlias: 'users_live',
		})
		let relationalBuilt = dialect.sqlToQuery(relationalQuery.sql as any)
		let relationalResult = await driver.execute(
			relationalBuilt.sql,
			relationalBuilt.params,
			'execute',
			{
				typings: relationalBuilt.typings,
			}
		)

		assert.deepEqual(relationalResult.rows, [{ id: userId, name: 'Starlight Glimmer' }])

		let updateQuery = dialect.sqlToQuery(
			dialect.buildUpdateQuery({
				table: users,
				set: { name: 'Starlight Updated' },
				where: eq(users.id, userId),
			})
		)
		await driver.execute(updateQuery.sql, updateQuery.params, 'execute', {
			typings: updateQuery.typings,
		})

		let updatedRows = await live.db.select().from(users).where(eq(users.id, userId))
		assert.deepEqual(updatedRows, [{ id: userId, name: 'Starlight Updated' }])

		let deleteQuery = dialect.sqlToQuery(
			dialect.buildDeleteQuery({
				table: users,
				where: eq(users.id, userId),
			})
		)
		await driver.execute(deleteQuery.sql, deleteQuery.params, 'execute', {
			typings: deleteQuery.typings,
		})

		let remainingRows = await live.db.select().from(users).where(eq(users.id, userId))
		assert.deepEqual(remainingRows, [])
	} finally {
		await live.deleteUserRows([userId])
	}
})

test('direct dialect helper wrappers execute on live YDB', async (t) => {
	if (!live.requireLiveYdb(t)) return
	live.describeDbChange(
		t,
		'insert two users and one post, then execute SQL composed directly from dialect fragment/set-operation helpers'
	)

	let dialect = new YdbDialect()
	let driver = live.db.$client as YdbDriver
	let firstUserId = live.baseIntId + 451
	let secondUserId = live.baseIntId + 452
	let postId = live.baseIntId + 453

	await live.deletePostRows([postId])
	await live.deleteUserRows([firstUserId, secondUserId])

	try {
		await live.db.insert(users).values([
			{ id: firstUserId, name: 'Luna' },
			{ id: secondUserId, name: 'Celestia' },
		])
		await live.db.insert(posts).values({ id: postId, userId: firstUserId, title: 'Moonlight' })

		let fields = orderSelectedFields({ userId: users.id, postTitle: posts.title })
		let selectionAliases = ['user_id_alias', 'post_title_alias']
		let mappedOrderBy = dialect.mapExpressionsToSelectionAliases(
			[users.id, yql`${posts.title} desc`],
			fields,
			selectionAliases,
			'orderBy()'
		)
		let helperQuery = dialect.sqlToQuery(
			yql`select ${dialect.buildSelection(
				fields,
				selectionAliases
			)} from ${dialect.buildFromTable(users)}${dialect.buildJoins([
				{ table: posts, joinType: 'left', on: eq(users.id, posts.userId) },
			])} where ${eq(users.id, firstUserId)}${dialect.buildOrderBy(
				mappedOrderBy
			)}${dialect.buildLimit(1)}${dialect.buildOffset(0)}`
		)

		let helperResult = await driver.execute(helperQuery.sql, helperQuery.params, 'execute', {
			typings: helperQuery.typings,
		})

		assert.deepEqual(helperResult.rows, [
			{
				user_id_alias: firstUserId,
				post_title_alias: 'Moonlight',
			},
		])

		let leftSelectBuilder = live.db
			.select({ value: users.name })
			.from(users)
			.where(eq(users.id, firstUserId))
		let rightUnionBuilder = live.db
			.select({ value: users.name })
			.from(users)
			.where(eq(users.id, secondUserId))
		let rightExceptBuilder = live.db
			.select({ value: users.name })
			.from(users)
			.where(eq(users.id, firstUserId))
		let setFields = orderSelectedFields(leftSelectBuilder.getSelectedFields())
		let setAliases = dialect.getSelectionAliases(setFields)
		let leftSelect = leftSelectBuilder.getSQL(setAliases)

		let singleSetQuery = dialect.sqlToQuery(
			dialect.buildSetOperationQuery(leftSelect, setFields, setAliases, {
				type: 'union',
				isAll: true,
				rightSelect: rightUnionBuilder,
				orderBy: [users.name],
			})
		)
		let singleSetResult = await driver.execute(
			singleSetQuery.sql,
			singleSetQuery.params,
			'execute',
			{
				typings: singleSetQuery.typings,
			}
		)

		assert.deepEqual(singleSetResult.rows, [{ __ydb_f0: 'Celestia' }, { __ydb_f0: 'Luna' }])

		let chainedSetQuery = dialect.sqlToQuery(
			dialect.buildSetOperations(leftSelect, setFields, setAliases, [
				{
					type: 'union',
					isAll: true,
					rightSelect: rightUnionBuilder,
				},
				{
					type: 'except',
					isAll: false,
					rightSelect: rightExceptBuilder,
				},
			])
		)
		let chainedSetResult = await driver.execute(
			chainedSetQuery.sql,
			chainedSetQuery.params,
			'execute',
			{
				typings: chainedSetQuery.typings,
			}
		)

		assert.deepEqual(chainedSetResult.rows, [{ __ydb_f0: 'Celestia' }])
	} finally {
		await live.deletePostRows([postId])
		await live.deleteUserRows([firstUserId, secondUserId])
	}
})
