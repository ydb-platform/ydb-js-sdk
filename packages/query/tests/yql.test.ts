import * as assert from 'node:assert'
import test from 'node:test'

import { table, yql } from '../dist/esm/yql.js'
import { Int32 } from '@ydbjs/value/primitive'


await test("YQL", async (tc) => {
	await tc.test("string", (tc) => {
		let { text } = yql`SELECT 1;`

		assert.equal(text, "SELECT 1;")
	})

	await tc.test("string with js value as parameter", (tc) => {
		let { text, params } = yql`SELECT ${1};`

		assert.equal(text, "SELECT $p0;")
		assert.deepStrictEqual(params[`$p0`], new Int32(1))
	})

	await tc.test("string with ydb value as parameter", (tc) => {
		let { text, params } = yql`SELECT ${new Int32(1)};`

		assert.equal(text, "SELECT $p0;")
		assert.deepStrictEqual(params[`$p0`], new Int32(1))
	})

	await tc.test("string with parameter and unsafe", (tc) => {
		let { text, params } = yql`FROM ${table("my_table")} SELECT ${1}, ${2};`

		assert.equal(text, "FROM `my_table` SELECT $p1, $p2;")
		assert.deepStrictEqual(params[`$p1`], new Int32(1))
		assert.deepStrictEqual(params[`$p2`], new Int32(2))
	})
})
