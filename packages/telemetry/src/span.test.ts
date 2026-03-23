import { expect, test } from 'vitest'

import { getBaseAttributes } from './tracing.js'
import { DB_SYSTEM } from './constants.js'
import { createSpan } from './span.js'

test('getBaseAttributes returns db.system.name, server and network.peer fields', () => {
	let attrs = getBaseAttributes('localhost', 2135)
	expect(attrs['db.system.name']).toBe(DB_SYSTEM)
	expect(attrs['server.address']).toBe('localhost')
	expect(attrs['server.port']).toBe(2135)
	expect(attrs['network.peer.address']).toBe('localhost')
	expect(attrs['network.peer.port']).toBe(2135)
	expect(attrs['db.namespace']).toBeUndefined()
})

test('getBaseAttributes includes db.namespace when provided as string', () => {
	let attrs = getBaseAttributes('ydb.example.com', 2135, '/local')
	expect(attrs['db.namespace']).toBe('/local')
})

test('getBaseAttributes accepts options object with peer and node', () => {
	let attrs = getBaseAttributes('server.ydb', 2135, {
		dbNamespace: '/prod',
		peerAddress: '10.0.0.1',
		peerPort: 2136,
		nodeId: 1,
		nodeDc: 'dc1',
	})
	expect(attrs['server.address']).toBe('server.ydb')
	expect(attrs['network.peer.address']).toBe('10.0.0.1')
	expect(attrs['network.peer.port']).toBe(2136)
	expect(attrs['db.namespace']).toBe('/prod')
	expect(attrs['ydb.node.id']).toBe(1)
	expect(attrs['ydb.node.dc']).toBe('dc1')
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
