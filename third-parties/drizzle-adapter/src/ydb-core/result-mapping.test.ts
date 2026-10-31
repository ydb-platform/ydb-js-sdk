import { deepStrictEqual } from 'node:assert/strict'
import { expect, test } from 'vitest'
import { sql as yql } from 'drizzle-orm'
import { drizzle } from '../index.ts'
import { integer, ydbTable } from '../schema.ts'
import { mapResultRow, orderSelectedFields, rowToArray } from './result-mapping.ts'

test('selected prototype names are returned as own fields', async () => {
	let db = drizzle(async () => ({ rows: [[1, 2, 3]] }))
	let fields = Object.fromEntries(
		['__proto__', 'constructor', 'toString'].map((name) => [name, yql`1`])
	)
	let rows = await db.select(fields).execute()
	expect(rows).toStrictEqual([JSON.parse('{"__proto__":1,"constructor":2,"toString":3}')])
	expect(Object.getPrototypeOf(rows[0])).toBe(Object.prototype)
})

test('nested result paths create own objects instead of traversing a prototype', () => {
	let fields = orderSelectedFields({
		['__proto__']: { ['__proto__']: yql`1` },
		constructor: { ['__proto__']: yql`2` },
	})
	let result = mapResultRow<Record<string, object>>(fields, [1, 2])
	// Vitest's strict matcher treats an own constructor field as class identity.
	deepStrictEqual(
		result,
		JSON.parse('{"__proto__":{"__proto__":1},"constructor":{"__proto__":2}}')
	)
	expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
	expect(Object.getPrototypeOf(result.__proto__)).toBe(Object.prototype)
	expect(Object.getPrototypeOf(result.constructor)).toBe(Object.prototype)
})

test('inherited column names and aliases use the existing positional fallback', () => {
	let table = ydbTable('row_values', { value: integer('constructor') })
	let row = Object.assign(Object.create({ constructor: 99, alias: 99, selected: 99 }), {
		actual: 42,
	})
	expect(rowToArray([{ path: ['value'], field: table.value }], row)).toEqual([42])
	expect(rowToArray([{ path: ['value'], field: yql`1`.as('alias') }], row)).toEqual([42])
	expect(rowToArray([{ path: ['selected'], field: yql`1` }], row)).toEqual([42])
	expect(rowToArray([{ path: ['missing'], field: yql`1` }], {})).toEqual([undefined])
})

test('own null and undefined cells are not replaced by inherited or positional values', () => {
	let fields = orderSelectedFields({
		['__proto__']: yql`1`,
		constructor: yql`2`,
	})
	let row = { other: 42, ['__proto__']: null, constructor: undefined }
	expect(rowToArray(fields, row)).toEqual([null, undefined])
})

test('nullable joins honor own object and table names', () => {
	let table = ydbTable('constructor', { value: integer() })
	let fields = orderSelectedFields({ ['__proto__']: { ['__proto__']: table.value } })
	let result = mapResultRow<Record<string, unknown>>(fields, [null], {})
	expect(result).toStrictEqual(JSON.parse('{"__proto__":null}'))
	expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
	let present = mapResultRow(fields, [null], { constructor: true })
	expect(present).toStrictEqual(JSON.parse('{"__proto__":{"__proto__":null}}'))
})
