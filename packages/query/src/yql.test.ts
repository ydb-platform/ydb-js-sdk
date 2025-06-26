import { expect, test } from 'vitest'

import { Int32 } from '@ydbjs/value/primitive'
import { identifier, yql } from './yql.ts'

test('processes string template', () => {
	let { text } = yql`SELECT 1;`

	expect(text).eq('SELECT 1;')
})

test('processes string with js value as parameter', () => {
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

test('processes string with ydb value as parameter', () => {
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

test('processes string with parameters and identifiers', () => {
	let { text, params } = yql`FROM ${identifier('my_table')}.${identifier('my_column')} SELECT ${1}, ${2};`

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

test(`string with falsy parameters`, () => {
	let { text, params } = yql`SELECT * FROM table WHERE str = ${""} AND int = ${0} AND int64 = ${0n} AND bool = ${false};`

	expect(text).eq('SELECT * FROM table WHERE str = $p0 AND int = $p1 AND int64 = $p2 AND bool = $p3;')
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
