import { expect, test } from 'vitest'

import { Int32 } from '@ydbjs/value/primitive'

import { fragment, identifier, join, unsafe, yql } from './yql.ts'

test('processes string template', () => {
	let { text } = yql`SELECT 1;`

	expect(text).eq('SELECT 1;')
})

test('handles string input', () => {
	let { text, params } = yql('SELECT 1;')

	expect(text).eq('SELECT 1;')
	expect(Object.keys(params)).toHaveLength(0)
})

test('handles empty template literal', () => {
	let { text, params } = yql``

	expect(text).eq('')
	expect(Object.keys(params)).toHaveLength(0)
})

test('processes js values as parameters', () => {
	let { text, params } = yql`SELECT ${1};`

	expect(text).eq('SELECT $p0;')
	expect(params).toMatchInlineSnapshot(`
		{
		  "$p0": Int32 {
		    "type": Int32Type {},
		    "value": 1,
		  },
		}
	`)
})

test('processes ydb values as parameters', () => {
	let { text, params } = yql`SELECT ${new Int32(1)};`

	expect(text).eq('SELECT $p0;')
	expect(params).toMatchInlineSnapshot(`
		{
		  "$p0": Int32 {
		    "type": Int32Type {},
		    "value": 1,
		  },
		}
	`)
})

test('processes mixed parameters and identifiers', () => {
	let { text, params } =
		yql`FROM ${identifier('my_table')}.${identifier('my_column')} SELECT ${1}, ${2};`

	expect(text).eq('FROM `my_table`.`my_column` SELECT $p0, $p1;')
	expect(params).toMatchInlineSnapshot(`
		{
		  "$p0": Int32 {
		    "type": Int32Type {},
		    "value": 1,
		  },
		  "$p1": Int32 {
		    "type": Int32Type {},
		    "value": 2,
		  },
		}
	`)
})

test('handles falsy values', () => {
	let { text, params } =
		yql`SELECT * FROM table WHERE str = ${''} AND int = ${0} AND int64 = ${0n} AND bool = ${false};`

	expect(text).eq(
		'SELECT * FROM table WHERE str = $p0 AND int = $p1 AND int64 = $p2 AND bool = $p3;'
	)
	expect(params).toMatchInlineSnapshot(`
		{
		  "$p0": Text {
		    "type": TextType {},
		    "value": "",
		  },
		  "$p1": Int32 {
		    "type": Int32Type {},
		    "value": 0,
		  },
		  "$p2": Int64 {
		    "type": Int64Type {},
		    "value": 0n,
		  },
		  "$p3": Bool {
		    "type": BoolType {},
		    "value": false,
		  },
		}
	`)
})

test('throws detailed error for undefined value', () => {
	// oxlint-disable-next-line no-unassigned-vars
	let undefinedVar: any

	expect(() => {
		void yql`SELECT ${undefinedVar};`
	}).toThrowErrorMatchingInlineSnapshot(`
		[Error: ❌ Undefined value at position 0 in yql template. This usually means:
		  • A variable wasn't initialized
		  • A function returned undefined
		  • An object property doesn't exist
		For intentional null database values, use YDB Optional type.]
	`)
})

test('throws detailed error for null value', () => {
	expect(() => {
		void yql`SELECT ${42}, ${null}, ${true};`
	}).toThrowErrorMatchingInlineSnapshot(`
		[Error: ❌ Null value at position 1 in yql template. JavaScript null is not directly supported in YDB queries.
		For null database values, use YDB Optional type instead.]
	`)
})

test('handles unsafe strings', () => {
	let { text, params } = yql`SELECT * FROM ${identifier('table')} WHERE id = ${1};`

	expect(text).eq('SELECT * FROM `table` WHERE id = $p0;')
	expect(params).toHaveProperty('$p0')
	expect(Object.keys(params)).toHaveLength(1)
})

test('handles multiple unsafe values', () => {
	let { text, params } =
		yql`SELECT ${identifier('col1')}, ${identifier('col2')} FROM ${identifier('table')};`

	expect(text).eq('SELECT `col1`, `col2` FROM `table`;')
	expect(Object.keys(params)).toHaveLength(0)
})

test('handles mixed unsafe and safe values', () => {
	let { text, params } =
		yql`SELECT ${identifier('name')}, ${42} FROM ${identifier('users')} WHERE id = ${1};`

	expect(text).eq('SELECT `name`, $p0 FROM `users` WHERE id = $p1;')
	expect(params).toHaveProperty('$p0')
	expect(params).toHaveProperty('$p1')
	expect(Object.keys(params)).toHaveLength(2)
})

test('creates identifier unsafe string', () => {
	let id = identifier('my_table')

	expect(id.toString()).eq('`my_table`')
	expect(id).toBeInstanceOf(String)
})

test('creates unsafe string', () => {
	let raw = unsafe('RAW SQL')

	expect(raw.toString()).eq('RAW SQL')
	expect(raw).toBeInstanceOf(String)
})

test('identifier escapes backticks inside names', () => {
	let id = identifier('my`table')

	expect(id.toString()).eq('`my``table`')
})

test('public exports identifier/unsafe behave correctly', async () => {
	// Import from public entry to ensure re-exports work in tests
	const { identifier: pubIdentifier, unsafe: pubUnsafe } = await import('./index.ts')

	expect(pubIdentifier('users').toString()).eq('`users`')
	expect(pubIdentifier('a`b').toString()).eq('`a``b`')
	expect(pubUnsafe('ORDER BY created_at DESC').toString()).eq('ORDER BY created_at DESC')
})

test('public exports fragment/join compose into a query', async () => {
	const { fragment: pubFragment, join: pubJoin } = await import('./index.ts')

	let conds = [pubFragment`a = ${1}`, pubFragment`b = ${2}`]
	let { text, params } = yql`WHERE ${pubJoin(conds, ' AND ')};`

	expect(text).eq('WHERE a = $p0 AND b = $p1;')
	expect(Object.keys(params)).toHaveLength(2)
})

test('handles various data types', () => {
	let { text, params } = yql`SELECT ${true}, ${'hello'}, ${123}, ${123n};`

	expect(text).eq('SELECT $p0, $p1, $p2, $p3;')
	expect(Object.keys(params)).toHaveLength(4)
	expect(params).toHaveProperty('$p0')
	expect(params).toHaveProperty('$p1')
	expect(params).toHaveProperty('$p2')
	expect(params).toHaveProperty('$p3')
})

test('handles complex parameter mixing', () => {
	let { text, params } = yql`
		SELECT ${identifier('name')}, ${42}
		FROM ${identifier('users')}
		WHERE ${identifier('age')} > ${18}
		AND ${identifier('status')} = ${'active'}
		ORDER BY ${identifier('created_at')}
	`

	// Should have correct parameter numbering
	expect(text).toContain('$p0') // 42
	expect(text).toContain('$p1') // 18
	expect(text).toContain('$p2') // 'active'
	expect(Object.keys(params)).toHaveLength(3)
})

test('handles unsafe values at boundaries', () => {
	let { text, params } =
		yql`${identifier('SELECT')} ${1} ${identifier('FROM')} ${identifier('table')}`

	expect(text).eq('`SELECT` $p0 `FROM` `table`')
	expect(Object.keys(params)).toHaveLength(1)
	expect(params).toHaveProperty('$p0')
})

test('validates all parameters and reports first error', () => {
	expect(() => {
		void yql`SELECT ${undefined}, ${null};`
	}).toThrowErrorMatchingInlineSnapshot(`
		[Error: ❌ Undefined value at position 0 in yql template. This usually means:
		  • A variable wasn't initialized
		  • A function returned undefined
		  • An object property doesn't exist
		For intentional null database values, use YDB Optional type.]
	`)
})

test('continues parameter numbering across a fragment boundary', () => {
	let frag = fragment`b = ${10}`
	let { text, params } = yql`SELECT ${1}, ${frag}, ${2};`

	expect(text).eq('SELECT $p0, b = $p1, $p2;')
	expect(Object.keys(params)).toHaveLength(3)
})

test('flattens a fragment nested inside another fragment', () => {
	let inner = fragment`x = ${1}`
	let outer = fragment`(${inner} AND y = ${2})`
	let { text, params } = yql`WHERE ${outer};`

	expect(text).eq('WHERE (x = $p0 AND y = $p1);')
	expect(Object.keys(params)).toHaveLength(2)
})

test('joins fragments with a separator', () => {
	let parts = [fragment`a = ${1}`, fragment`b = ${2}`, fragment`c = ${3}`]
	let { text, params } = yql`WHERE ${join(parts, ' AND ')};`

	expect(text).eq('WHERE a = $p0 AND b = $p1 AND c = $p2;')
	expect(Object.keys(params)).toHaveLength(3)
})

test('joins an empty list into empty text', () => {
	let { text, params } = yql`SELECT 1 ${join([])};`

	expect(text).eq('SELECT 1 ;')
	expect(Object.keys(params)).toHaveLength(0)
})

test('joins a single fragment without the separator', () => {
	let { text, params } = yql`WHERE ${join([fragment`a = ${1}`], ' AND ')};`

	expect(text).eq('WHERE a = $p0;')
	expect(Object.keys(params)).toHaveLength(1)
})

test('handles identifier and unsafe inside a fragment', () => {
	let frag = fragment`${identifier('col')} = ${5} ${unsafe('DESC')}`
	let { text, params } = yql`ORDER BY ${frag};`

	expect(text).eq('ORDER BY `col` = $p0 DESC;')
	expect(Object.keys(params)).toHaveLength(1)
})

test('throws for undefined value inside a fragment', () => {
	let frag = fragment`x = ${undefined}`

	expect(() => void yql`WHERE ${frag};`).toThrow(/Undefined value/)
})

test('composes a dynamic KNN search with filter conditions', () => {
	let meta = identifier('metadata')
	let filter = { source: 'wiki', lang: 'en' }
	let conds = Object.entries(filter).map(
		([k, v]) => fragment`JSON_VALUE(${meta}, ${unsafe(`'$.${k}'`)}) = ${v}`
	)
	let where = fragment`WHERE ${join(conds, ' AND ')}`
	let { text, params } = yql`
		SELECT Knn::CosineSimilarity(${identifier('embedding')}, ${new Uint8Array([1, 2, 3])}) AS score
		FROM ${identifier('vectors')} ${where}
		ORDER BY score DESC LIMIT ${10};`

	expect(text).toContain('Knn::CosineSimilarity(`embedding`, $p0)')
	expect(text).toContain("JSON_VALUE(`metadata`, '$.source') = $p1")
	expect(text).toContain("JSON_VALUE(`metadata`, '$.lang') = $p2")
	expect(text).toContain('LIMIT $p3')
	expect(Object.keys(params)).toHaveLength(4)
})
