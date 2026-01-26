import { create } from '@bufbuild/protobuf'
import { credentials } from '@grpc/grpc-js'
import { EndpointInfoSchema } from '@ydbjs/api/discovery'
import { expect, test } from 'vitest'
import { ConnectionPool } from '../src/pool.js'

test('acquires connection with preferNodeId', () => {
	let pool = new ConnectionPool(credentials.createInsecure())

	let endpoint1 = create(EndpointInfoSchema, {
		address: 'localhost',
		port: 2135,
		nodeId: 1,
		location: 'VLA',
	})

	let endpoint2 = create(EndpointInfoSchema, {
		address: 'localhost',
		port: 2136,
		nodeId: 2,
		location: 'VLA',
	})

	pool.add(endpoint1)
	pool.add(endpoint2)

	let conn = pool.acquire(2n)
	expect(conn.nodeId).toBe(2n)
})

test('acquires connection with round-robin', () => {
	let pool = new ConnectionPool(credentials.createInsecure())

	let endpoint1 = create(EndpointInfoSchema, {
		address: 'localhost',
		port: 2135,
		nodeId: 1,
		location: 'VLA',
	})

	let endpoint2 = create(EndpointInfoSchema, {
		address: 'localhost',
		port: 2136,
		nodeId: 2,
		location: 'VLA',
	})

	pool.add(endpoint1)
	pool.add(endpoint2)

	let conn1 = pool.acquire()
	let conn2 = pool.acquire()
	let conn3 = pool.acquire()

	expect(conn1.nodeId).toBe(1n)
	expect(conn2.nodeId).toBe(2n)
	expect(conn3.nodeId).toBe(1n)
})

test('filters connections by preferredLocations', () => {
	let pool = new ConnectionPool(credentials.createInsecure())

	let endpointVLA = create(EndpointInfoSchema, {
		address: 'localhost',
		port: 2135,
		nodeId: 1,
		location: 'VLA',
	})

	let endpointSAS = create(EndpointInfoSchema, {
		address: 'localhost',
		port: 2136,
		nodeId: 2,
		location: 'SAS',
	})

	let endpointMAN = create(EndpointInfoSchema, {
		address: 'localhost',
		port: 2137,
		nodeId: 3,
		location: 'MAN',
	})

	pool.add(endpointVLA)
	pool.add(endpointSAS)
	pool.add(endpointMAN)

	let conn = pool.acquireWithOptions({
		preferredLocations: ['SAS', 'MAN'],
	})

	expect(['SAS', 'MAN']).toContain(conn.endpoint.location)
})

test('filters connections by preferLocalDC', () => {
	let pool = new ConnectionPool(credentials.createInsecure())

	let endpointVLA = create(EndpointInfoSchema, {
		address: 'localhost',
		port: 2135,
		nodeId: 1,
		location: 'VLA',
	})

	let endpointSAS = create(EndpointInfoSchema, {
		address: 'localhost',
		port: 2136,
		nodeId: 2,
		location: 'SAS',
	})

	pool.add(endpointVLA)
	pool.add(endpointSAS)

	pool.setLocalDC('VLA')

	let conn = pool.acquireWithOptions({
		preferLocalDC: true,
	})

	expect(conn.endpoint.location).toBe('VLA')
})

test('preferredLocations takes precedence over preferLocalDC', () => {
	let pool = new ConnectionPool(credentials.createInsecure())

	let endpointVLA = create(EndpointInfoSchema, {
		address: 'localhost',
		port: 2135,
		nodeId: 1,
		location: 'VLA',
	})

	let endpointSAS = create(EndpointInfoSchema, {
		address: 'localhost',
		port: 2136,
		nodeId: 2,
		location: 'SAS',
	})

	pool.add(endpointVLA)
	pool.add(endpointSAS)

	pool.setLocalDC('VLA')

	let conn = pool.acquireWithOptions({
		preferLocalDC: true,
		preferredLocations: ['SAS'],
	})

	expect(conn.endpoint.location).toBe('SAS')
})

test('falls back to all connections when no preferred available', () => {
	let pool = new ConnectionPool(credentials.createInsecure())

	let endpointVLA = create(EndpointInfoSchema, {
		address: 'localhost',
		port: 2135,
		nodeId: 1,
		location: 'VLA',
	})

	pool.add(endpointVLA)

	let conn = pool.acquireWithOptions({
		preferredLocations: ['SAS'],
		allowFallback: true,
	})

	expect(conn.endpoint.location).toBe('VLA')
})

test('throws error when no preferred available and fallback disabled', () => {
	let pool = new ConnectionPool(credentials.createInsecure())

	let endpointVLA = create(EndpointInfoSchema, {
		address: 'localhost',
		port: 2135,
		nodeId: 1,
		location: 'VLA',
	})

	pool.add(endpointVLA)

	expect(() => {
		pool.acquireWithOptions({
			preferredLocations: ['SAS'],
			allowFallback: false,
		})
	}).toThrow('No connections matching client options')
})

test('combines preferNodeId with location filtering', () => {
	let pool = new ConnectionPool(credentials.createInsecure())

	let endpointVLA1 = create(EndpointInfoSchema, {
		address: 'localhost',
		port: 2135,
		nodeId: 1,
		location: 'VLA',
	})

	let endpointVLA2 = create(EndpointInfoSchema, {
		address: 'localhost',
		port: 2136,
		nodeId: 2,
		location: 'VLA',
	})

	let endpointSAS = create(EndpointInfoSchema, {
		address: 'localhost',
		port: 2137,
		nodeId: 3,
		location: 'SAS',
	})

	pool.add(endpointVLA1)
	pool.add(endpointVLA2)
	pool.add(endpointSAS)

	let conn = pool.acquireWithOptions({
		preferredLocations: ['VLA'],
		preferNodeId: 2n,
	})

	expect(conn.nodeId).toBe(2n)
	expect(conn.endpoint.location).toBe('VLA')
})
