import { create } from '@bufbuild/protobuf'
import { PileState_State } from '@ydbjs/api/bridge'
import { ListEndpointsResultSchema } from '@ydbjs/api/discovery'
import { expect, test } from 'vitest'

import { EndpointsUnavailableError } from '../errors.ts'
import { mapDiscoveryResult } from './endpoints-runtime.ts'
import type { DiscoveredEndpoint } from './endpoints-state.ts'
import {
	type EndpointPoolHarness,
	capture,
	discoveryResult,
	endpoint,
	makeEndpointPool,
	makeFakeConnectionFactory,
	makeFakeDiscovery,
	settle,
} from './endpoints.fixtures.ts'

let setup = function setup(
	endpoints: DiscoveredEndpoint[],
	over: Parameters<typeof makeEndpointPool>[0] = {}
): EndpointPoolHarness {
	let discovery = over.discovery ?? makeFakeDiscovery()
	let connections = over.connections ?? makeFakeConnectionFactory()
	discovery.push(discoveryResult(endpoints))
	return makeEndpointPool({ ...over, discovery, connections })
}

test('acquire routes to a discovered node after ready', async (tc) => {
	await using h = setup([endpoint(1), endpoint(2)])
	await h.pool.ready(tc.signal)
	let conn = h.pool.acquire()
	expect([1n, 2n]).toContain(conn.endpoint.nodeId)
})

test('channels are materialized lazily on first acquire, then reused', async (tc) => {
	await using h = setup([endpoint(1), endpoint(2)])
	await h.pool.ready(tc.signal)
	expect(h.connections.factoryCalls()).toBe(0)

	h.pool.acquire(1n)
	expect(h.connections.factoryCalls()).toBe(1)

	h.pool.acquire(1n)
	expect(h.connections.factoryCalls()).toBe(1)
})

test('a pessimized node is skipped on the next acquire', async (tc) => {
	await using h = setup([endpoint(1), endpoint(2)])
	await h.pool.ready(tc.signal)

	h.pool.report(1n, false)
	await settle()

	// node 1 is pessimized → prefer is [node 2].
	expect(h.pool.acquire().endpoint.nodeId).toBe(2n)
})

test('a successful RPC optimistically un-bans a node', async (tc) => {
	await using h = setup([endpoint(1), endpoint(2)])
	await h.pool.ready(tc.signal)

	h.pool.report(1n, false)
	await settle()
	expect(h.pool.snapshot.byNodeId.get(1n)!.state).toBe('pessimized')

	h.pool.report(1n, true)
	await settle()
	expect(h.pool.snapshot.byNodeId.get(1n)!.state).toBe('active')
})

test('a new discovery round is reflected in routing', async (tc) => {
	let discovery = makeFakeDiscovery()
	await using h = setup([endpoint(1), endpoint(2)], { discovery })
	await h.pool.ready(tc.signal)

	using added = capture('ydb:driver.connection.added')
	using retired = capture('ydb:driver.connection.retired')

	discovery.push(discoveryResult([endpoint(1), endpoint(3)]))
	h.pool.forceRediscovery()
	await settle()

	let preferIds = h.pool.snapshot.prefer.map((r) => r.nodeId).sort()
	expect(preferIds).toEqual([1n, 3n])
	expect((added.events.at(-1) as { nodeId: bigint }).nodeId).toBe(3n)
	expect((retired.events.at(-1) as { nodeId: bigint }).nodeId).toBe(2n)
})

test('direct-IO: pin then acquire the exact server-named node', async (tc) => {
	await using h = setup([endpoint(1)])
	await h.pool.ready(tc.signal)

	h.pool.pin(9n, 'node-9', 2136)
	await settle()

	let conn = h.pool.acquireNode(9n)
	expect(conn.endpoint.nodeId).toBe(9n)
})

test('direct-IO: a hard-pin to an absent node throws', async (tc) => {
	await using h = setup([endpoint(1)])
	await h.pool.ready(tc.signal)
	expect(() => h.pool.acquireNode(99n, { hard: true })).toThrow(EndpointsUnavailableError)
})

test('direct-IO: invalidate makes a pinned node unreachable', async (tc) => {
	await using h = setup([endpoint(1)])
	await h.pool.ready(tc.signal)

	h.pool.pin(9n, 'node-9', 2136)
	await settle()
	expect(h.pool.acquireNode(9n).endpoint.nodeId).toBe(9n)

	h.pool.invalidate(9n)
	await settle()
	expect(() => h.pool.acquireNode(9n, { hard: true })).toThrow(EndpointsUnavailableError)
})

test('acquire before ready throws EndpointsUnavailableError', async () => {
	await using h = setup([endpoint(1)])
	expect(() => h.pool.acquire()).toThrow(EndpointsUnavailableError)
})

test('publishes ydb:driver.connection.pessimized when a node is reported failed', async (tc) => {
	await using h = setup([endpoint(1), endpoint(2)])
	await h.pool.ready(tc.signal)

	using pessimized = capture('ydb:driver.connection.pessimized')
	h.pool.report(1n, false)
	await settle()

	let event = pessimized.events.at(-1) as { nodeId: bigint; address: string }
	expect(event.nodeId).toBe(1n)
	expect(event.address).toBe('node-1:2136')
})

test('publishes ydb:driver.ready once discovery succeeds', async (tc) => {
	using ready = capture('ydb:driver.ready')
	await using h = setup([endpoint(1)])
	await h.pool.ready(tc.signal)
	expect(ready.events).toHaveLength(1)
})

test('close drains and publishes ydb:driver.closed', async (tc) => {
	using closed = capture('ydb:driver.closed')
	let h = setup([endpoint(1)])
	await h.pool.ready(tc.signal)
	await h.pool.close()
	expect(closed.events).toHaveLength(1)
})

test('close closes every materialized channel', async (tc) => {
	let connections = makeFakeConnectionFactory()
	let h = setup([endpoint(1), endpoint(2)], { connections })
	await h.pool.ready(tc.signal)
	h.pool.acquire(1n)
	h.pool.acquire(2n)

	await h.pool.close()
	expect(connections.materialized.every((c) => c.closed)).toBe(true)
})

// ── proto → domain adapter (bridge wire-real) ────────────────────────────────

test('mapDiscoveryResult maps proto endpoints, self_location, and bridge pile states', () => {
	let result = create(ListEndpointsResultSchema, {
		selfLocation: 'A',
		endpoints: [
			{
				address: 'h1',
				port: 2136,
				nodeId: 1,
				location: 'A',
				bridgePileName: 'p1',
				loadFactor: 0.5,
				ipV4: ['10.0.0.1'],
			},
		],
		pileStates: [
			{ pileName: 'p1', state: PileState_State.PRIMARY },
			{ pileName: 'p2', state: PileState_State.DISCONNECTED },
		],
	})
	let dto = mapDiscoveryResult(result)
	expect(dto.selfLocation).toBe('A')
	expect(dto.endpoints[0]).toMatchObject({
		nodeId: 1n,
		host: 'h1',
		port: 2136,
		bridgePileName: 'p1',
		loadFactor: 0.5,
		ipV4: ['10.0.0.1'],
	})
	expect(dto.pileStates).toEqual([
		{ pileName: 'p1', status: 'PRIMARY' },
		{ pileName: 'p2', status: 'DISCONNECTED' },
	])
})

test('mapDiscoveryResult leaves pile states empty for a non-bridge cluster', () => {
	let result = create(ListEndpointsResultSchema, {
		selfLocation: 'A',
		endpoints: [{ address: 'h1', port: 2136, nodeId: 1, location: 'A' }],
	})
	let dto = mapDiscoveryResult(result)
	expect(dto.pileStates).toHaveLength(0)
	expect(dto.endpoints[0]!.bridgePileName).toBe('')
})
