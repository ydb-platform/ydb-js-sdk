import { expect, test } from 'vitest'

import { Int32 } from '@ydbjs/value/primitive'
import { table, yql } from '../dist/esm/yql.js'

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

test('string with parameter and unsafe', () => {
	let { text, params } = yql`FROM ${table('my_table')} SELECT ${1}, ${2};`

	expect(text).eq('FROM `my_table` SELECT $p1, $p2;')
	expect(params).toMatchInlineSnapshot(`
		{
		  "$p1": Int32 {
		    "type": Int32Type {},
		    "value": 1,
		  },
		  "$p2": Int32 {
		    "type": Int32Type {},
		    "value": 2,
		  },
		}
	`)
})
