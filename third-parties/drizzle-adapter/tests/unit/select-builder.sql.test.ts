import { test } from 'vitest'
import assert from 'node:assert/strict'
import { desc, eq, sql as yql } from 'drizzle-orm'
import {
	asTable,
	commit,
	cube,
	declareParam,
	defineAction,
	distinctHint,
	doAction,
	doBlock,
	except,
	groupKey,
	grouping,
	groupingSets,
	hop,
	hopEnd,
	hopStart,
	indexView,
	intersect,
	intoResult,
	kMeansTreeSearchTopSize,
	knnCosineSimilarity,
	pragma,
	rollup,
	sessionStart,
	sessionWindow,
	unionAll,
	uniqueHint,
	values,
	vectorIndexView,
	windowDefinition,
	yqlScript,
} from '../../src/index.ts'
import { YdbSelectBuilder } from '../../src/ydb-core/query-builders/index.ts'
import { dialect, posts, session, users } from '../helpers/unit-basic.ts'

function toQuery(builder: { getSQL(): any }) {
	return dialect.sqlToQuery(builder.getSQL())
}

test('select sql', () => {
	let query = toQuery(new YdbSelectBuilder(session).from(users).where(eq(users.id, 7)))

	assert.equal(
		query.sql,
		'select `users`.`id`, `users`.`name`, `users`.`created_at`, `users`.`updated_at` from `users` where `users`.`id` = $p0'
	)
	assert.deepEqual(query.params, [7])
})

test('select without from sql', () => {
	let query = toQuery(new YdbSelectBuilder(session, { value: yql<number>`${1}` }))

	assert.equal(query.sql, 'select $p0')
	assert.deepEqual(query.params, [1])
})

test('select advanced clauses sql', () => {
	let query = toQuery(
		new YdbSelectBuilder(session)
			.from(users)
			.distinct()
			.groupBy(users.id, users.name, users.createdAt, users.updatedAt)
			.having(yql`count(*) > ${1}`)
			.orderBy(desc(users.name), users.id)
			.limit(5)
			.offset(2)
	)

	assert.equal(
		query.sql,
		'select distinct `users`.`id`, `users`.`name`, `users`.`created_at`, `users`.`updated_at` from `users` group by `users`.`id`, `users`.`name`, `users`.`created_at`, `users`.`updated_at` having count(*) > $p0 order by `users`.`name` desc, `users`.`id` limit $p1 offset $p2'
	)
	assert.deepEqual(query.params, [1, 5, 2])
})

test('join sql', () => {
	let leftJoinQuery = toQuery(
		new YdbSelectBuilder(session, { userId: users.id, postId: posts.id })
			.from(users)
			.leftJoin(posts, eq(users.id, posts.userId))
			.orderBy(users.id, posts.id)
	)
	let innerJoinQuery = toQuery(
		new YdbSelectBuilder(session, { userId: users.id, postId: posts.id })
			.from(users)
			.innerJoin(posts, eq(users.id, posts.userId))
	)
	let rightJoinQuery = toQuery(
		new YdbSelectBuilder(session, { userId: users.id, postId: posts.id })
			.from(users)
			.rightJoin(posts, eq(users.id, posts.userId))
	)
	let fullJoinQuery = toQuery(
		new YdbSelectBuilder(session, { userId: users.id, postId: posts.id })
			.from(users)
			.fullJoin(posts, eq(users.id, posts.userId))
	)
	let crossJoinQuery = toQuery(
		new YdbSelectBuilder(session, { userId: users.id, postId: posts.id })
			.from(users)
			.crossJoin(posts)
	)
	let leftSemiJoinQuery = toQuery(
		new YdbSelectBuilder(session, { userId: users.id })
			.from(users)
			.leftSemiJoin(posts, eq(users.id, posts.userId))
	)
	let rightOnlyJoinQuery = toQuery(
		new YdbSelectBuilder(session, { userId: users.id })
			.from(users)
			.rightOnlyJoin(posts, eq(users.id, posts.userId))
	)
	let exclusionJoinQuery = toQuery(
		new YdbSelectBuilder(session, { userId: users.id })
			.from(users)
			.exclusionJoin(posts, eq(users.id, posts.userId))
	)

	assert.equal(
		leftJoinQuery.sql,
		'select `users`.`id` as `__ydb_f0`, `posts`.`id` as `__ydb_f1` from `users` left join `posts` on `users`.`id` = `posts`.`user_id` order by `users`.`id`, `posts`.`id`'
	)
	assert.equal(
		innerJoinQuery.sql,
		'select `users`.`id` as `__ydb_f0`, `posts`.`id` as `__ydb_f1` from `users` inner join `posts` on `users`.`id` = `posts`.`user_id`'
	)
	assert.equal(
		rightJoinQuery.sql,
		'select `users`.`id` as `__ydb_f0`, `posts`.`id` as `__ydb_f1` from `users` right join `posts` on `users`.`id` = `posts`.`user_id`'
	)
	assert.equal(
		fullJoinQuery.sql,
		'select `users`.`id` as `__ydb_f0`, `posts`.`id` as `__ydb_f1` from `users` full join `posts` on `users`.`id` = `posts`.`user_id`'
	)
	assert.equal(
		crossJoinQuery.sql,
		'select `users`.`id` as `__ydb_f0`, `posts`.`id` as `__ydb_f1` from `users` cross join `posts`'
	)
	assert.equal(
		leftSemiJoinQuery.sql,
		'select `users`.`id` as `__ydb_f0` from `users` left semi join `posts` on `users`.`id` = `posts`.`user_id`'
	)
	assert.equal(
		rightOnlyJoinQuery.sql,
		'select `users`.`id` as `__ydb_f0` from `users` right only join `posts` on `users`.`id` = `posts`.`user_id`'
	)
	assert.equal(
		exclusionJoinQuery.sql,
		'select `users`.`id` as `__ydb_f0` from `users` exclusion join `posts` on `users`.`id` = `posts`.`user_id`'
	)
})

test('index view table source sql', () => {
	let query = toQuery(
		new YdbSelectBuilder(session, {
			id: yql`${yql.identifier('u')}.${yql.identifier('id')}`,
		}).from(indexView(users, 'users_name_idx', 'u'))
	)

	assert.equal(query.sql, 'select `u`.`id` from `users` view `users_name_idx` as `u`')
})

test('YDB SELECT source helpers render AS_TABLE, VALUES, and top-level VALUES', () => {
	let asTableQuery = toQuery(
		new YdbSelectBuilder(session, {
			id: yql`${yql.identifier('r')}.${yql.identifier('id')}`,
		}).from(asTable('$rows', 'r'))
	)
	let fromAsTableQuery = toQuery(
		new YdbSelectBuilder(session, {
			id: yql`${yql.identifier('r')}.${yql.identifier('id')}`,
		}).fromAsTable('rows', 'r')
	)
	let fromValuesQuery = toQuery(
		new YdbSelectBuilder(session, {
			id: yql`${yql.identifier('v')}.${yql.identifier('id')}`,
			name: yql`${yql.identifier('v')}.${yql.identifier('name')}`,
		}).fromValues(
			[
				[1, 'one'],
				[2, 'two'],
			],
			{ alias: 'v', columns: ['id', 'name'] }
		)
	)
	let topLevelValues = dialect.sqlToQuery(
		values([
			{ id: 1, name: 'one' },
			{ id: 2, name: 'two' },
		])
	)

	assert.equal(asTableQuery.sql, 'select `r`.`id` from AS_TABLE($rows) as `r`')
	assert.equal(fromAsTableQuery.sql, 'select `r`.`id` from AS_TABLE($rows) as `r`')
	assert.equal(
		fromValuesQuery.sql,
		'select `v`.`id`, `v`.`name` from (VALUES ($p0, $p1), ($p2, $p3)) as `v`(`id`, `name`)'
	)
	assert.deepEqual(fromValuesQuery.params, [1, 'one', 2, 'two'])
	assert.equal(topLevelValues.sql, 'VALUES ($p0, $p1), ($p2, $p3)')
	assert.deepEqual(topLevelValues.params, [1, 'one', 2, 'two'])
})

test('YDB SELECT gaps render WITHOUT, FLATTEN, SAMPLE, TABLESAMPLE, and MATCH_RECOGNIZE', () => {
	let withoutQuery = toQuery(
		new YdbSelectBuilder(session).from(users).without(users.name).where(eq(users.id, 7))
	)
	let flattenQuery = toQuery(
		new YdbSelectBuilder(session, { item: yql`${yql.identifier('items')}` })
			.from(yql.raw('(select AsList(1, 2) as items)'))
			.flattenListBy(yql.identifier('items'))
			.orderBy(yql.identifier('items'))
	)
	let sampleQuery = toQuery(
		new YdbSelectBuilder(session, { id: users.id }).from(users).sample(0.25)
	)
	let tableSampleQuery = toQuery(
		new YdbSelectBuilder(session, { id: users.id }).from(users).tableSample('bernoulli', 10, 7)
	)
	let matchRecognizeQuery = toQuery(
		new YdbSelectBuilder(session, { bTs: yql`${yql.identifier('b_ts')}` })
			.from(yql.raw('(select 1 as ts, 1 as button)'))
			.matchRecognize({
				orderBy: [yql.identifier('ts')],
				measures: {
					b_ts: yql.raw('LAST(B.ts)'),
				},
				rowsPerMatch: 'ONE ROW PER MATCH',
				pattern: '(A B)',
				define: {
					A: yql.raw('A.button = 1'),
					B: yql.raw('B.button = 2'),
				},
			})
	)

	assert.equal(withoutQuery.sql, 'select * WITHOUT `name` from `users` where `users`.`id` = $p0')
	assert.deepEqual(withoutQuery.params, [7])
	assert.equal(
		flattenQuery.sql,
		'select `items` from (select AsList(1, 2) as items) flatten list by `items` order by `items`'
	)
	assert.equal(sampleQuery.sql, 'select `users`.`id` from `users` sample $p0')
	assert.deepEqual(sampleQuery.params, [0.25])
	assert.equal(
		tableSampleQuery.sql,
		'select `users`.`id` from `users` tablesample bernoulli($p0) repeatable($p1)'
	)
	assert.deepEqual(tableSampleQuery.params, [10, 7])
	assert.equal(
		matchRecognizeQuery.sql,
		'select `b_ts` from (select 1 as ts, 1 as button) match_recognize (ORDER BY `ts` MEASURES LAST(B.ts) AS `b_ts` ONE ROW PER MATCH PATTERN (A B) DEFINE A AS A.button = 1, B AS B.button = 2)'
	)
})

test('YDB SELECT renders unique/distinct hints, ASSUME ORDER BY, WINDOW, INTO RESULT, and advanced GROUP BY', () => {
	let uniqueDistinctQuery = toQuery(
		new YdbSelectBuilder(session, { id: users.id })
			.from(users)
			.uniqueDistinct(uniqueHint('id'), distinctHint('name'))
	)
	let assumeOrderQuery = toQuery(
		new YdbSelectBuilder(session, { id: users.id, name: users.name })
			.from(users)
			.assumeOrderBy('id', yql.raw('name DESC'))
	)
	let windowQuery = toQuery(
		new YdbSelectBuilder(session, {
			id: users.id,
			rn: yql`row_number() over w`,
		})
			.from(users)
			.window(
				'w',
				windowDefinition({
					partitionBy: [users.name],
					orderBy: [users.id],
					frame: 'ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW',
				})
			)
	)
	let groupQuery = toQuery(
		new YdbSelectBuilder(session, {
			mask: grouping(users.name, users.id),
			count: yql`count(*)`,
		})
			.from(users)
			.groupCompactBy(
				rollup(users.name, users.id),
				cube(users.id),
				groupingSets([users.name], [users.id])
			)
	)
	let sessionWindowQuery = toQuery(
		new YdbSelectBuilder(session, {
			sessionStart: sessionStart(),
			count: yql`count(*)`,
		})
			.from(users)
			.groupBy(groupKey(sessionWindow(users.createdAt, 'PT1H'), 'session_start'))
	)
	let hopQuery = toQuery(
		new YdbSelectBuilder(session, {
			hopStart: hopStart(),
			hopEnd: hopEnd(),
			count: yql`count(*)`,
		})
			.from(users)
			.groupBy(hop(users.createdAt, 'PT10S', 'PT1M', 'PT30S'), users.id)
	)
	let intoResultQuery = toQuery(
		new YdbSelectBuilder(session, { id: users.id })
			.from(users)
			.limit(1)
			.intoResult('selected_users')
	)
	let knnQuery = toQuery(
		new YdbSelectBuilder(session, {
			similarity: knnCosineSimilarity(yql.identifier('embedding'), yql.raw('$target')),
		})
			.from(vectorIndexView('articles', 'emb_idx', 'a'))
			.orderBy(yql.raw('similarity DESC'))
			.limit(10)
	)

	assert.equal(
		uniqueDistinctQuery.sql,
		'select /*+ unique(id) distinct(name) */ `users`.`id` from `users`'
	)
	assert.equal(
		assumeOrderQuery.sql,
		'select `users`.`id`, `users`.`name` from `users` assume order by `id`, name DESC'
	)
	assert.equal(
		windowQuery.sql,
		'select `users`.`id`, row_number() over w from `users` window `w` AS (PARTITION BY `users`.`name` ORDER BY `users`.`id` ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)'
	)
	assert.equal(
		groupQuery.sql,
		'select GROUPING(`users`.`name`, `users`.`id`), count(*) from `users` group compact by ROLLUP(`users`.`name`, `users`.`id`), CUBE(`users`.`id`), GROUPING SETS((`users`.`name`), (`users`.`id`))'
	)
	assert.equal(
		sessionWindowQuery.sql,
		'select SessionStart(), count(*) from `users` group by SessionWindow(`users`.`created_at`, $p0) AS `session_start`'
	)
	assert.deepEqual(sessionWindowQuery.params, ['PT1H'])
	assert.equal(
		hopQuery.sql,
		'select HOP_START(), HOP_END(), count(*) from `users` group by HOP(`users`.`created_at`, $p0, $p1, $p2), `users`.`id`'
	)
	assert.deepEqual(hopQuery.params, ['PT10S', 'PT1M', 'PT30S'])
	assert.equal(
		intoResultQuery.sql,
		'select `users`.`id` from `users` limit $p0 into result `selected_users`'
	)
	assert.deepEqual(intoResultQuery.params, [1])
	assert.equal(
		knnQuery.sql,
		'select Knn::CosineSimilarity(`embedding`, $target) from `articles` view `emb_idx` as `a` order by similarity DESC limit $p0'
	)
	assert.deepEqual(knnQuery.params, [10])
})

test('YDB script helpers render PRAGMA, DECLARE, ACTION, COMMIT, and INTO RESULT', () => {
	let scriptQuery = dialect.sqlToQuery(
		yqlScript(
			declareParam('$name', 'Utf8'),
			pragma('TablePathPrefix', '/Root'),
			pragma('Warning', ['disable', '1101']),
			kMeansTreeSearchTopSize(10),
			defineAction(
				'$hello',
				['$name', { name: 'suffix', optional: true }],
				['SELECT "Hello";']
			),
			doAction('$hello', [yql.raw('$name')]),
			doBlock(['SELECT 1;']),
			commit()
		)
	)
	let intoResultQuery = dialect.sqlToQuery(
		intoResult(
			new YdbSelectBuilder(session, { id: users.id }).from(users).getSQL(),
			'Result name'
		)
	)

	assert.equal(
		scriptQuery.sql,
		[
			'DECLARE $name AS Utf8;',
			'PRAGMA TablePathPrefix = "/Root";',
			'PRAGMA Warning("disable", "1101");',
			'PRAGMA ydb.KMeansTreeSearchTopSize = "10";',
			'DEFINE ACTION $hello($name, $suffix?) AS',
			'SELECT "Hello";',
			'END DEFINE;',
			'DO $hello($name);',
			'DO BEGIN',
			'SELECT 1;',
			'END DO;',
			'COMMIT;',
		].join('\n')
	)
	assert.equal(intoResultQuery.sql, 'select `users`.`id` from `users` INTO RESULT `Result name`;')
})

test('distinctOn and set operators sql', () => {
	let distinctOnQuery = toQuery(
		new YdbSelectBuilder(session, { userId: posts.userId, title: posts.title })
			.from(posts)
			.distinctOn(posts.userId)
			.orderBy(posts.userId, desc(posts.title))
	)
	let variadicDistinctOnQuery = toQuery(
		new YdbSelectBuilder(session, { userId: posts.userId, title: posts.title })
			.from(posts)
			.distinctOn(posts.userId, posts.title)
	)

	let unionQuery = toQuery(
		unionAll(
			new YdbSelectBuilder(session, { value: users.name }).from(users).where(eq(users.id, 1)),
			new YdbSelectBuilder(session, { value: posts.title })
				.from(posts)
				.where(eq(posts.userId, 1))
		)
			.orderBy((fields: { value: unknown }) => fields.value as any)
			.limit(3)
	)

	let intersectQuery = toQuery(
		intersect(
			new YdbSelectBuilder(session, { value: users.name }).from(users).where(eq(users.id, 1)),
			new YdbSelectBuilder(session, { value: posts.title })
				.from(posts)
				.where(eq(posts.userId, 1))
		)
	)

	let exceptQuery = toQuery(
		except(
			new YdbSelectBuilder(session, { value: users.name }).from(users).where(eq(users.id, 1)),
			new YdbSelectBuilder(session, { value: posts.title })
				.from(posts)
				.where(eq(posts.userId, 1))
		)
	)

	assert.match(
		distinctOnQuery.sql,
		/^select `__ydb_f0`, `__ydb_f1` from \(select `posts`\.`user_id` as `__ydb_f0`, `posts`\.`title` as `__ydb_f1`, row_number\(\) over \(\s+partition by `posts`\.`user_id`\s+ order by `posts`\.`user_id`, `posts`\.`title` desc\s+\) as `__ydb_row_number` from `posts`\) as `__ydb_distinct_on` where `__ydb_distinct_on`\.`__ydb_row_number` = 1 order by `__ydb_f0`, `__ydb_f1` desc$/
	)
	assert.ok(
		variadicDistinctOnQuery.sql.includes('partition by `posts`.`user_id`, `posts`.`title`')
	)
	assert.equal(
		unionQuery.sql,
		'select `users`.`name` as `__ydb_f0` from `users` where `users`.`id` = $p0 union all select `posts`.`title` as `__ydb_f0` from `posts` where `posts`.`user_id` = $p1 order by `__ydb_f0` limit $p2'
	)
	assert.equal(
		intersectQuery.sql,
		'select distinct `__ydb_left`.`__ydb_f0` as `__ydb_f0` from (select `users`.`name` as `__ydb_f0` from `users` where `users`.`id` = $p0) as `__ydb_left` inner join (select `__ydb_right_input`.`__ydb_f0` as `__ydb_f0`, 1 as `__ydb_match` from (select `posts`.`title` as `__ydb_f0` from `posts` where `posts`.`user_id` = $p1) as `__ydb_right_input`) as `__ydb_right` on `__ydb_left`.`__ydb_f0` = `__ydb_right`.`__ydb_f0`'
	)
	assert.equal(
		exceptQuery.sql,
		'select distinct `__ydb_left`.`__ydb_f0` as `__ydb_f0` from (select `users`.`name` as `__ydb_f0` from `users` where `users`.`id` = $p0) as `__ydb_left` left join (select `__ydb_right_input`.`__ydb_f0` as `__ydb_f0`, 1 as `__ydb_match` from (select `posts`.`title` as `__ydb_f0` from `posts` where `posts`.`user_id` = $p1) as `__ydb_right_input`) as `__ydb_right` on `__ydb_left`.`__ydb_f0` = `__ydb_right`.`__ydb_f0` where `__ydb_right`.`__ydb_match` is null'
	)
	assert.deepEqual(unionQuery.params, [1, 1, 3])
	assert.deepEqual(intersectQuery.params, [1, 1])
	assert.deepEqual(exceptQuery.params, [1, 1])
})
