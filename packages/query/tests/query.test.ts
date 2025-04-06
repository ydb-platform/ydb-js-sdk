import * as assert from 'node:assert'
import test from 'node:test'

import { Type_PrimitiveTypeId } from '@ydbjs/api/value'
import { Driver } from '@ydbjs/core'
import { fromJs } from '@ydbjs/value'
import { Optional } from '@ydbjs/value/optional'
import { PrimitiveType, Uint64 } from '@ydbjs/value/primitive'

import { query } from '@ydbjs/query'

await test("QueryService", async (tc) => {
	let driver = new Driver(process.env.YDB_CONNECTION_STRING as string)
	await driver.ready()

	await tc.test("Simple query", async () => {
		let sql = query(driver)

		let resultSets = await sql`SELECT 1 AS id`

		assert.deepEqual(resultSets, [[{ id: 1 }]])
	})

	await tc.test("Query with parameters", async () => {
		let sql = query(driver)

		let resultSets = await sql`SELECT ${1} AS id`
		assert.deepEqual(resultSets, [[{ id: 1 }]])
	})

	await tc.test("Query with named parameters", async () => {
		let sql = query(driver)

		let resultSets = await sql`SELECT $param1 as id`
			.parameter("param1", fromJs(1))

		assert.deepEqual(resultSets, [[{ id: 1 }]])
	})

	await tc.test("Query with named parameters and types", async () => {
		let sql = query(driver)

		let resultSets = await sql`SELECT $param1 as id`
			.parameter("param1", new Uint64(1n))

		assert.deepEqual(resultSets, [[{ id: 1n }]])
	})

	await tc.test("Query with multiple parameters", async () => {
		let sql = query(driver)

		let resultSets = await sql`SELECT $param1 as id, ${"Neo"} as name`
			.parameter("param1", fromJs(1))

		assert.deepEqual(resultSets, [[{ id: 1, name: "Neo" }]])
	})

	await tc.test("Query with multiple result sets", async () => {
		let sql = query(driver)

		let resultSets = await sql`SELECT 1 AS id; SELECT 2 AS id`
		assert.deepEqual(resultSets, [
			[{ id: 1 }],
			[{ id: 2 }],
		])
	})

	await tc.test("Query with multiple result sets and parameters", async () => {
		let sql = query(driver)

		let resultSets = await sql`SELECT $param1 AS id; SELECT $param2 AS id`
			.parameter("param1", fromJs(1))
			.parameter("param2", fromJs(2))

		assert.deepEqual(resultSets, [
			[{ id: 1 }],
			[{ id: 2 }],
		])
	})

	await tc.test("Query with CAST", async () => {
		let sql = query(driver)

		let resultSets = await sql`SELECT CAST($param1 as Uint64) AS id`
			.parameter("param1", fromJs(1))

		assert.deepEqual(resultSets, [[{ id: 1n }]])
	})

	await tc.test("Query with typed value", async () => {
		let sql = query(driver)

		let resultSets = await sql`SELECT ${new Uint64(1n)} AS id`
		assert.deepEqual(resultSets, [[{ id: 1n }]])
	})

	await tc.test("Query with optional value", async () => {
		let sql = query(driver)

		let resultSets = await sql`SELECT CAST(${new Optional(null, new PrimitiveType(Type_PrimitiveTypeId.UINT64))} AS Uint64?) AS id`
		assert.deepEqual(resultSets, [[{ id: null }]])
	})

	await tc.test("Query with table parameter using AS_TABLE", async () => {
		let sql = query(driver)

		let resultSets = await sql`SELECT * FROM AS_TABLE(${[{ id: 1, name: "Neo" }]})`
		assert.deepEqual(resultSets, [[{ id: 1, name: "Neo" }]])
	})

	await tc.test("Query with list of structs", async () => {
		let sql = query(driver)

		let resultSets = await sql`SELECT * FROM AS_TABLE(${[{ id: 1, name: "Neo" }, { id: 2, name: "Morpheus", program: true }]})`
		assert.deepEqual(resultSets, [[{ id: 1, name: "Neo", program: null }, { id: 2, name: "Morpheus", program: true }]])
	})
})
