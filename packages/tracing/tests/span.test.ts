import { expect, test } from 'vitest'

import { DB_SYSTEM } from '../src/constants.js'
import { getBaseAttributes } from '../src/span.js'

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
