import { expect, test } from 'vitest'

import { DB_SYSTEM } from './constants.js'
import { createSpan, getBaseAttributes } from './span.js'

test('getBaseAttributes returns db.system and server fields', () => {
	let attrs = getBaseAttributes('localhost', 2135)
	expect(attrs['db.system']).toBe(DB_SYSTEM)
	expect(attrs['server.address']).toBe('localhost')
	expect(attrs['server.port']).toBe(2135)
	expect(attrs['db.namespace']).toBeUndefined()
})

test('getBaseAttributes includes db.namespace when provided', () => {
	let attrs = getBaseAttributes('ydb.example.com', 2135, '/local')
	expect(attrs['db.namespace']).toBe('/local')
})

test('createSpan returns result of fn when fn resolves', async () => {
	let base = getBaseAttributes('localhost', 2136)
	let result = await createSpan('test.op', base, async () => 42)
	expect(result).toBe(42)
})

test('createSpan rethrows when fn rejects', async () => {
	let base = getBaseAttributes('localhost', 2136)
	let err = new Error('expected failure')
	await expect(
		createSpan('test.op', base, async () => {
			throw err
		})
	).rejects.toThrow('expected failure')
})

test('createSpan passes span to fn', async () => {
	let base = getBaseAttributes('localhost', 2136)
	let receivedSpan = null as unknown
	await createSpan('test.op', base, async (span) => {
		receivedSpan = span
		return undefined
	})
	expect(receivedSpan).not.toBeNull()
	expect(typeof (receivedSpan as { end: unknown }).end).toBe('function')
})
