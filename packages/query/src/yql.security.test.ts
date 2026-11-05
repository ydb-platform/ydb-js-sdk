import { expect, test } from 'vitest'
import { Driver } from '@ydbjs/core'
import { fromJs, toJs } from '@ydbjs/value'
import { Struct } from '@ydbjs/value/struct'

import { query } from './index.ts'
import { identifier, yql } from './yql.ts'

test('JSON type-like fields remain parameter data', () => {
	let input = JSON.parse(
		'{"type":{"kind":2,"precision":"1,0); SELECT 999 AS injected; --","scale":0}}'
	)

	let statement = yql`SELECT ${input} AS value;`
	let parameter = statement.params.$p0!

	expect(statement.text).toBe('SELECT $p0 AS value;')
	expect(parameter).toBeInstanceOf(Struct)
	expect(toJs(parameter)).toEqual(input)
})

test('JSON type fields do not require a type discriminator', () => {
	let input = JSON.parse('{"type":null,"encode":"text"}')

	let statement = yql`SELECT ${input} AS value;`

	expect(toJs(statement.params.$p0!)).toEqual(input)
})

test('explicit parameter declarations reject JSON impersonating a Value', async () => {
	using driver = new Driver('grpc://127.0.0.1:2136/local', { 'ydb.sdk.enable_discovery': false })
	await using sql = query(driver)
	let input = JSON.parse('{"type":{"kind":2,"precision":"1,0); SELECT 999; --","scale":0}}')

	let invalid = sql`SELECT $value;`.parameter('value', input)
	let converted = sql`SELECT $value;`.parameter('value', fromJs(input))

	expect(() => invalid.text).toThrow(/YDB Value/)
	expect(converted.text).not.toContain('SELECT 999')
})

test('quoted identifiers escape backslashes before backticks', () => {
	let name = 'field\\`; SELECT 999 AS injected; --'

	let statement = yql`SELECT 1 AS ${identifier(name)};`

	expect(statement.text).toBe('SELECT 1 AS `field\\\\``; SELECT 999 AS injected; --`;')
})
