import { expect, test } from 'vitest'

import { Int32 } from '@ydbjs/value/primitive'
import { identifier, yql } from './yql.ts'

test('string', () => {
	let { text } = yql`SELECT 1;`

	expect(text).eq('SELECT 1;')
})

test('string with js value as parameter', () => {
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

test('string with ydb value as parameter', () => {
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

test('string with parameters and identifiers', () => {
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
