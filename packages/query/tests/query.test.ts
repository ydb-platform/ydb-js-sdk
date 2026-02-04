import { expect, inject, test } from 'vitest'

import { Driver } from '@ydbjs/core'
import { fromJs } from '@ydbjs/value'
import { Optional } from '@ydbjs/value/optional'
import { Uint64, Uint64Type } from '@ydbjs/value/primitive'

import { query } from '../src/index.js'

let driver = new Driver(inject('connectionString'), {
	'ydb.sdk.enable_discovery': false,
})
await driver.ready()

test('executes simple query', async () => {
	await using sql = query(driver)

	expect(await sql`SELECT 1 AS id`).toMatchInlineSnapshot(`
		[
		  [
		    {
		      "id": 1,
		    },
		  ],
		]
	`)
})

test('executes query with parameters', async () => {
	await using sql = query(driver)

	let resultSets = await sql`SELECT ${1} AS id`
	expect(resultSets).toMatchInlineSnapshot(`
		[
		  [
		    {
		      "id": 1,
		    },
		  ],
		]
	`)
})

test('executes query with named parameters', async () => {
	await using sql = query(driver)

	let resultSets = await sql`SELECT $param1 as id`.parameter(
		'param1',
		fromJs(1)
	)
	expect(resultSets).toMatchInlineSnapshot(`
		[
		  [
		    {
		      "id": 1,
		    },
		  ],
		]
	`)
})

test('executes query with named parameters and types', async () => {
	await using sql = query(driver)

	let resultSets = await sql`SELECT $param1 as id`.parameter(
		'param1',
		new Uint64(1n)
	)
	expect(resultSets).toMatchInlineSnapshot(`
		[
		  [
		    {
		      "id": 1n,
		    },
		  ],
		]
	`)
})

test('executes query with multiple parameters', async () => {
	await using sql = query(driver)

	let resultSets =
		await sql`SELECT $param1 as id, ${'Neo'} as name`.parameter(
			'param1',
			fromJs(1)
		)
	expect(resultSets).toMatchInlineSnapshot(`
		[
		  [
		    {
		      "id": 1,
		      "name": "Neo",
		    },
		  ],
		]
	`)
})

test('executes query with multiple result sets', async () => {
	await using sql = query(driver)

	let resultSets = await sql`SELECT 1 AS id; SELECT 2 AS id`
	expect(resultSets).toMatchInlineSnapshot(`
		[
		  [
		    {
		      "id": 1,
		    },
		  ],
		  [
		    {
		      "id": 2,
		    },
		  ],
		]
	`)
})

test('executes query with multiple result sets and parameters', async () => {
	await using sql = query(driver)

	let resultSets = await sql`SELECT $param1 AS id; SELECT $param2 AS id`
		.parameter('param1', fromJs(1))
		.parameter('param2', fromJs(2))

	expect(resultSets).toMatchInlineSnapshot(`
		[
		  [
		    {
		      "id": 1,
		    },
		  ],
		  [
		    {
		      "id": 2,
		    },
		  ],
		]
	`)
})

test('executes query with CAST', async () => {
	await using sql = query(driver)

	let resultSets = await sql`SELECT CAST($param1 as Uint64) AS id`.parameter(
		'param1',
		fromJs(1)
	)

	expect(resultSets).toMatchInlineSnapshot(`
		[
		  [
		    {
		      "id": 1n,
		    },
		  ],
		]
	`)
})

test('executes query with typed value', async () => {
	await using sql = query(driver)

	let resultSets = await sql`SELECT ${new Uint64(1n)} AS id`
	expect(resultSets).toMatchInlineSnapshot(`
		[
		  [
		    {
		      "id": 1n,
		    },
		  ],
		]
	`)
})

test('executes query with optional value', async () => {
	await using sql = query(driver)

	let resultSets =
		await sql`SELECT CAST(${new Optional(null, new Uint64Type())} AS Uint64?) AS id`
	expect(resultSets).toMatchInlineSnapshot(`
		[
		  [
		    {
		      "id": null,
		    },
		  ],
		]
	`)
})

test('executes query with table parameter using AS_TABLE', async () => {
	await using sql = query(driver)

	let resultSets =
		await sql`SELECT * FROM AS_TABLE(${[{ id: 1, name: 'Neo' }]})`
	expect(resultSets).toMatchInlineSnapshot(`
		[
		  [
		    {
		      "id": 1,
		      "name": "Neo",
		    },
		  ],
		]
	`)
})

test('executes query with list of structs', async () => {
	await using sql = query(driver)

	let resultSets = await sql`SELECT * FROM AS_TABLE(${[
		{ id: 1, name: 'Neo' },
		{ id: 2, name: 'Morpheus', program: true },
	]})`
	expect(resultSets).toMatchInlineSnapshot(`
		[
		  [
		    {
		      "id": 1,
		      "name": "Neo",
		      "program": null,
		    },
		    {
		      "id": 2,
		      "name": "Morpheus",
		      "program": true,
		    },
		  ],
		]
	`)
})

test('executes simple transaction', async () => {
	await using sql = query(driver)

	let resultSets = await sql.begin(async (tx) => {
		return await tx`SELECT 1 AS id`
	})

	expect(resultSets).toMatchInlineSnapshot(`
		[
		  [
		    {
		      "id": 1,
		    },
		  ],
		]
	`)
})

test('executes transaction with parameters', async () => {
	await using sql = query(driver)

	let resultSets = await sql.begin(async (tx) => {
		return await tx`SELECT ${1} AS id`
	})

	expect(resultSets).toMatchInlineSnapshot(`
		[
		  [
		    {
		      "id": 1,
		    },
		  ],
		]
	`)
})

test('executes transaction with multiple queries', async () => {
	await using sql = query(driver)

	let resultSets = await sql.begin(async (tx) => {
		let resultSets = await tx`SELECT 1 AS id;`

		return await tx`SELECT * from AS_TABLE(${resultSets[0]})`
	})

	expect(resultSets).toMatchInlineSnapshot(`
		[
		  [
		    {
		      "id": 1,
		    },
		  ],
		]
	`)
})

test('executes parallel transactions and queries', async () => {
	await using sql = query(driver)

	let results = await Promise.all([
		sql.begin(async (tx) => {
			return await Promise.all([
				tx`SELECT 1 AS id`,
				tx`SELECT 2 AS id`,
				tx`SELECT 3 AS id`,
			])
		}),
		sql.begin(async (tx) => {
			return await Promise.all([
				tx`SELECT 4 AS id`,
				tx`SELECT 5 AS id`,
				tx`SELECT 6 AS id`,
			])
		}),
	])

	expect(results).toMatchInlineSnapshot(`
		[
		  [
		    [
		      [
		        {
		          "id": 1,
		        },
		      ],
		    ],
		    [
		      [
		        {
		          "id": 2,
		        },
		      ],
		    ],
		    [
		      [
		        {
		          "id": 3,
		        },
		      ],
		    ],
		  ],
		  [
		    [
		      [
		        {
		          "id": 4,
		        },
		      ],
		    ],
		    [
		      [
		        {
		          "id": 5,
		        },
		      ],
		    ],
		    [
		      [
		        {
		          "id": 6,
		        },
		      ],
		    ],
		  ],
		]
	`)
})

test('works with custom session pool size', async () => {
	await using sql = query(driver, { maxSize: 2 })

	let result1 = await sql`SELECT 1 AS id`
	let result2 = await sql`SELECT 2 AS id`

	expect(result1).toMatchInlineSnapshot(`
		[
		  [
		    {
		      "id": 1,
		    },
		  ],
		]
	`)
	expect(result2).toMatchInlineSnapshot(`
		[
		  [
		    {
		      "id": 2,
		    },
		  ],
		]
	`)
})

test('reuses sessions from pool', async () => {
	await using sql = query(driver, { maxSize: 1 })

	let result1 = await sql`SELECT 1 AS id`
	let result2 = await sql`SELECT 2 AS id`
	let result3 = await sql`SELECT 3 AS id`

	expect(result1).toEqual([[{ id: 1 }]])
	expect(result2).toEqual([[{ id: 2 }]])
	expect(result3).toEqual([[{ id: 3 }]])
})

test('handles concurrent queries with limited pool', async () => {
	await using sql = query(driver, { maxSize: 3 })

	let results = await Promise.all(
		Array.from({ length: 10 }, (_, i) => sql`SELECT ${i + 1} AS id`)
	)

	expect(results).toHaveLength(10)
	results.forEach((result, i) => {
		expect(result).toEqual([[{ id: i + 1 }]])
	})
})

test('releases sessions back to pool after query', async () => {
	await using sql = query(driver, { maxSize: 1 })

	let result1 = await sql`SELECT 1 AS id`
	expect(result1).toEqual([[{ id: 1 }]])

	let result2 = await sql`SELECT 2 AS id`
	expect(result2).toEqual([[{ id: 2 }]])

	let result3 = await sql`SELECT 3 AS id`
	expect(result3).toEqual([[{ id: 3 }]])
})

test('handles session pool with transactions', async () => {
	await using sql = query(driver, { maxSize: 1 })

	let result = await sql.begin(async (tx) => {
		let r1 = await tx`SELECT 1 AS id`
		let r2 = await tx`SELECT 2 AS id`
		return [r1, r2]
	})

	expect(result).toEqual([[[{ id: 1 }]], [[{ id: 2 }]]])
})

test('handles multiple concurrent transactions', async () => {
	await using sql = query(driver, { maxSize: 2 })

	let results = await Promise.all([
		sql.begin(async (tx) => {
			let r1 = await tx`SELECT 1 AS id`
			let r2 = await tx`SELECT 2 AS id`
			return [r1, r2]
		}),
		sql.begin(async (tx) => {
			let r1 = await tx`SELECT 3 AS id`
			let r2 = await tx`SELECT 4 AS id`
			return [r1, r2]
		}),
		sql.begin(async (tx) => {
			let r1 = await tx`SELECT 5 AS id`
			let r2 = await tx`SELECT 6 AS id`
			return [r1, r2]
		}),
	])

	expect(results[0]).toEqual([[[{ id: 1 }]], [[{ id: 2 }]]])
	expect(results[1]).toEqual([[[{ id: 3 }]], [[{ id: 4 }]]])
	expect(results[2]).toEqual([[[{ id: 5 }]], [[{ id: 6 }]]])
})
