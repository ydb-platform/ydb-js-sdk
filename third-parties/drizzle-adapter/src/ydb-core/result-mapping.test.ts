import { expect, test } from 'vitest'
import { eq, sql as yql } from 'drizzle-orm'
import { drizzle } from '../index.ts'
import { integer, ydbTable } from '../schema.ts'
import { mapResultRow, orderSelectedFields, rowToArray } from './result-mapping.ts'

type PrototypeLeaf = { toString: number }
type ValueLeaf = { value: number }
type NestedResult = {
	__proto__: { constructor: PrototypeLeaf }
	constructor: { group: ValueLeaf }
}
type JoinResult = Record<string, Record<string, null> | null>

test.for(['innerJoin', 'rightJoin'] as const)(
	'%s preserves a present nullable row from a __proto__ table',
	async (join) => {
		let base = ydbTable('base', { id: integer() })
		let joined = ydbTable('__proto__', { value: integer() })
		let db = drizzle(async () => ({ rows: [[null]] }))

		let selection = db.select({ joined: { value: joined.value } }).from(base)
		let rows = await selection[join](joined, yql`true`).execute()

		expect(rows).toEqual([{ joined: { value: null } }])
	}
)

test('automatic JOIN and WHERE callbacks can read a __proto__ selection group', async () => {
	let base = ydbTable('base', { id: integer() })
	let joined = ydbTable('__proto__', { value: integer() })
	let db = drizzle(async () => ({ rows: [[1, 1]] }))

	let selection = db
		.select()
		.from(base)
		.innerJoin(joined, (fields) => {
			let left = fields.base as typeof base
			let right = fields.__proto__ as typeof joined
			return eq(left.id, right.value)
		})
		.where((fields) => eq((fields.base as typeof base).id, 1))

	let { sql, params } = selection.toSQL()
	let rows = await selection.execute()

	expect(sql).toContain(
		'inner join `__proto__` on `base`.`id` = `__proto__`.`value` where `base`.`id` = $p0'
	)
	expect(params).toEqual([1])
	expect(rows).toEqual([JSON.parse('{"base":{"id":1},"__proto__":{"value":1}}')])
	expect(Object.getPrototypeOf(rows[0])).toBe(null)
})

test('WHERE callbacks can read joined fields when selecting from SQL', () => {
	let joined = ydbTable('joined', { value: integer() })
	let db = drizzle(async () => ({ rows: [] }))

	let query = db
		.select()
		.from(yql`AS_TABLE($input)`)
		.innerJoin(joined, yql`true`)
		.where((fields) => eq((fields.joined as typeof joined).value, 7))
		.toSQL()

	expect(query.sql).toContain('where `joined`.`value` = $p0')
	expect(query.params).toEqual([7])
})

test('selected prototype names are own fields of a null-prototype result', async () => {
	let db = drizzle(async () => ({ rows: [[1, 2, 3]] }))
	let names = ['__proto__', 'constructor', 'toString']
	let fields = Object.fromEntries(names.map((name) => [name, yql`1`]))

	let rows = await db.select(fields).execute()
	let row = rows[0]!

	expect(Object.getPrototypeOf(row)).toBe(null)
	expect(Object.keys(row)).toEqual(names)
	expect(Object.values(row)).toEqual([1, 2, 3])
	expect(JSON.stringify(row)).toBe('{"__proto__":1,"constructor":2,"toString":3}')
})

test('every nested result group has a null prototype', () => {
	let fields = orderSelectedFields({
		['__proto__']: { constructor: { toString: yql`1` } },
		constructor: { group: { value: yql`2` } },
	})

	let result = mapResultRow<NestedResult>(fields, [1, 2])

	expect(Object.getPrototypeOf(result)).toBe(null)
	expect(Object.getPrototypeOf(result.__proto__)).toBe(null)
	expect(Object.getPrototypeOf(result.__proto__.constructor)).toBe(null)
	expect(Object.getPrototypeOf(result.constructor)).toBe(null)
	expect(Object.getPrototypeOf(result.constructor.group)).toBe(null)
	expect(Object.entries(result.__proto__.constructor)).toEqual([['toString', 1]])
	expect(Object.entries(result.constructor.group)).toEqual([['value', 2]])
})

test('inherited column names and aliases use the positional fallback', () => {
	let table = ydbTable('row_values', { value: integer('constructor') })
	let row = Object.assign(Object.create({ constructor: 99, alias: 99, selected: 99 }), {
		actual: 42,
	})

	let column = rowToArray([{ path: ['value'], field: table.value }], row)
	let alias = rowToArray([{ path: ['value'], field: yql`1`.as('alias') }], row)
	let selected = rowToArray([{ path: ['selected'], field: yql`1` }], row)
	let missing = rowToArray([{ path: ['missing'], field: yql`1` }], {})

	expect(column).toEqual([42])
	expect(alias).toEqual([42])
	expect(selected).toEqual([42])
	expect(missing).toEqual([undefined])
})

test('JSON object rows preserve own special names and ignore inherited names', () => {
	let row = JSON.parse('{"actual":42,"__proto__":null,"constructor":7}')
	let fields = orderSelectedFields({ ['__proto__']: yql`1`, constructor: yql`2` })

	let own = rowToArray(fields, row)
	let inherited = rowToArray([{ path: ['toString'], field: yql`1` }], row)

	expect(own).toEqual([null, 7])
	expect(inherited).toEqual([42])
})

test('own null and undefined cells are not replaced by positional values', () => {
	let fields = orderSelectedFields({ ['__proto__']: yql`1`, constructor: yql`2` })
	let row = { other: 42, ['__proto__']: null, constructor: undefined }

	let values = rowToArray(fields, row)

	expect(values).toEqual([null, undefined])
})

test('nullable joins honor own object and table names', () => {
	let table = ydbTable('constructor', { value: integer() })
	let fields = orderSelectedFields({ ['__proto__']: { ['__proto__']: table.value } })
	let inherited = Object.create({ constructor: true })

	let absent = mapResultRow<JoinResult>(fields, [null], {})
	let inheritedOnly = mapResultRow<JoinResult>(fields, [null], inherited)
	let present = mapResultRow<JoinResult>(fields, [null], { constructor: true })

	expect(Object.getPrototypeOf(absent)).toBe(null)
	expect(Object.entries(absent)).toEqual([['__proto__', null]])
	expect(Object.entries(inheritedOnly)).toEqual([['__proto__', null]])
	expect(Object.getPrototypeOf(present)).toBe(null)
	expect(Object.getPrototypeOf(present.__proto__)).toBe(null)
	expect(Object.entries(present.__proto__!)).toEqual([['__proto__', null]])
})
