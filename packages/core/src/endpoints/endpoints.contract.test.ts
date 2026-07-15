import { create } from '@bufbuild/protobuf'
import { connectivityState } from '@grpc/grpc-js'
import { PileState_State } from '@ydbjs/api/bridge'
import { ListEndpointsResultSchema } from '@ydbjs/api/discovery'
import { ClientError, Status } from 'nice-grpc'
import { expect, test } from 'vitest'

import { EndpointsUnavailableError } from '../errors.ts'
import {
	type DiscoveryResult,
	defaultProtoEndpoint,
	mapDiscoveryResult,
} from './endpoints-runtime.ts'
import type { DiscoveredEndpoint } from './endpoints-state.ts'
import type { EndpointRef } from './snapshot.ts'
import {
	type EndpointPoolHarness,
	capture,
	discoveryResult,
	endpoint,
	makeEndpointPool,
	makeFakeConnectionFactory,
	makeFakeDiscovery,
	pile,
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

	h.pool.penalize(1n)
	await settle()

	// node 1 is pessimized → prefer is [node 2].
	expect(h.pool.acquire().endpoint.nodeId).toBe(2n)
})

test('a successful RPC optimistically un-bans a node', async (tc) => {
	await using h = setup([endpoint(1), endpoint(2)])
	await h.pool.ready(tc.signal)

	h.pool.penalize(1n)
	await settle()
	expect(h.pool.snapshot.byNodeId.get(1n)!.state).toBe('pessimized')

	h.pool.recover(1n)
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

// ── bridge (2DC) observability ───────────────────────────────────────────────

// node1 in the PRIMARY pile p1, node2 in the SYNCHRONIZED pile p2.
let bridgeRound = function bridgeRound(over: Partial<DiscoveryResult> = {}) {
	return discoveryResult(
		[endpoint(1, { bridgePileName: 'p1' }), endpoint(2, { bridgePileName: 'p2' })],
		{
			selfLocation: 'A',
			pileStates: [pile('p1', 'PRIMARY'), pile('p2', 'SYNCHRONIZED')],
			...over,
		}
	)
}

test('publishes ydb:driver.connection.pool.opened once with the driver config', async (tc) => {
	let discovery = makeFakeDiscovery()
	discovery.push(bridgeRound())
	using opened = capture('ydb:driver.connection.pool.opened')
	await using h = makeEndpointPool({ discovery, preferPrimaryPile: true })
	await h.pool.ready(tc.signal)

	expect(opened.events).toHaveLength(1)
	expect(opened.events[0]).toMatchObject({
		config: { preferPrimaryPile: true, localityEnabled: false },
	})
})

test('publishes discovery.completed with selfLocation, pile roster and primaryPile', async (tc) => {
	let discovery = makeFakeDiscovery()
	discovery.push(bridgeRound())
	using completed = capture('ydb:driver.discovery.completed')
	await using h = makeEndpointPool({ discovery })
	await h.pool.ready(tc.signal)

	expect(completed.events.at(-1)).toMatchObject({
		selfLocation: 'A',
		primaryPile: 'p1',
		piles: [
			{ name: 'p1', status: 'PRIMARY' },
			{ name: 'p2', status: 'SYNCHRONIZED' },
		],
	})
})

test('tags connection.added with the pile name', async (tc) => {
	let discovery = makeFakeDiscovery()
	discovery.push(bridgeRound())
	using added = capture('ydb:driver.connection.added')
	await using h = makeEndpointPool({ discovery })
	await h.pool.ready(tc.signal)

	expect(added.events).toEqual(
		expect.arrayContaining([expect.objectContaining({ nodeId: 1n, pile: 'p1' })])
	)
})

test('publishes pile.changed when the primary pile moves', async (tc) => {
	let discovery = makeFakeDiscovery()
	discovery.push(bridgeRound())
	await using h = makeEndpointPool({ discovery })
	await h.pool.ready(tc.signal)

	using changed = capture('ydb:driver.pile.changed')
	// Failover: p2 promoted to primary, p1 demoted to synchronized.
	discovery.push(bridgeRound({ pileStates: [pile('p1', 'SYNCHRONIZED'), pile('p2', 'PRIMARY')] }))
	h.pool.forceRediscovery()
	await settle()

	expect(changed.events).toHaveLength(1)
	expect(changed.events[0]).toMatchObject({ primaryBefore: 'p1', primaryAfter: 'p2' })
})

test('does not publish pile.changed when the roster is unchanged', async (tc) => {
	let discovery = makeFakeDiscovery()
	discovery.push(bridgeRound())
	await using h = makeEndpointPool({ discovery })
	await h.pool.ready(tc.signal)

	using changed = capture('ydb:driver.pile.changed')
	discovery.push(bridgeRound())
	h.pool.forceRediscovery()
	await settle()

	expect(changed.events).toHaveLength(0)
})

test('publishes pile.fallback when preferPrimaryPile has no primary node left', async (tc) => {
	let discovery = makeFakeDiscovery()
	discovery.push(bridgeRound())
	await using h = makeEndpointPool({ discovery, preferPrimaryPile: true })
	await h.pool.ready(tc.signal)

	using fallback = capture('ydb:driver.pile.fallback')
	// The only PRIMARY-pile node vanishes; only the SYNCHRONIZED node remains.
	discovery.push(
		discoveryResult([endpoint(2, { bridgePileName: 'p2' })], {
			selfLocation: 'A',
			pileStates: [pile('p1', 'PRIMARY'), pile('p2', 'SYNCHRONIZED')],
		})
	)
	h.pool.forceRediscovery()
	await settle()

	expect(fallback.events.at(-1)).toMatchObject({ active: true, primaryPile: 'p1' })
})

test('publishes pool.stats with tier counts and pile composition', async (tc) => {
	let discovery = makeFakeDiscovery()
	discovery.push(bridgeRound())
	using stats = capture('ydb:driver.connection.pool.stats')
	await using h = makeEndpointPool({ discovery, preferPrimaryPile: true })
	await h.pool.ready(tc.signal)

	expect(stats.events.at(-1)).toMatchObject({
		total: 2,
		prefer: 1,
		fallback: 1,
		pessimized: 0,
		piles: expect.arrayContaining([
			expect.objectContaining({ name: 'p1', status: 'PRIMARY', nodes: 1 }),
			expect.objectContaining({ name: 'p2', status: 'SYNCHRONIZED', nodes: 1 }),
		]),
	})
})

test('defaultProtoEndpoint carries the pile onto the production dial proto', () => {
	// Guards the onCall path: the fake connection factory bypasses this mapper, so
	// only a direct test catches a dropped pile on the real GrpcConnection.
	let ref: EndpointRef = {
		nodeId: 1n,
		address: 'h:2136',
		host: 'h',
		port: 2136,
		sslTargetNameOverride: '',
		ipV4: [],
		ipV6: [],
		location: 'A',
		pile: 'p1',
		state: 'active',
	}
	expect(defaultProtoEndpoint(ref).bridgePileName).toBe('p1')
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
	h.pool.penalize(1n)
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

// ── graceful close drain (no full-deadline stall) ────────────────────────────

test('close finalizes promptly without waiting the close deadline', async (tc) => {
	// A 30s deadline: if close() stalled on it, the 5s test timeout would fire.
	await using h = setup([endpoint(1), endpoint(2)], { closeDeadlineMs: 30_000 })
	await h.pool.ready(tc.signal)
	h.pool.acquire(1n)
	h.pool.acquire(2n)

	await h.pool.close()
	expect(h.connections.materialized.every((c) => c.closed)).toBe(true)
})

test('close waits for an in-flight call to drain, then finalizes', async (tc) => {
	let closed = false
	let h = setup([endpoint(1)], { closeDeadlineMs: 30_000 })
	await h.pool.ready(tc.signal)
	h.pool.acquire(1n)
	h.pool.callStarted(1n) // simulate an in-flight RPC on node 1

	let closing = h.pool.close().then(() => {
		closed = true
	})
	await settle()
	// The busy channel keeps close() pending.
	expect(closed).toBe(false)
	expect(h.connections.byNode(1n)!.closed).toBe(false)

	h.pool.callEnded(1n) // the RPC finishes → channel drains → finalize
	await closing
	expect(closed).toBe(true)
	expect(h.connections.byNode(1n)!.closed).toBe(true)
})

test('acquire after close throws EndpointsUnavailableError', async (tc) => {
	let h = setup([endpoint(1)])
	await h.pool.ready(tc.signal)
	await h.pool.close()
	expect(() => h.pool.acquire()).toThrow(EndpointsUnavailableError)
	expect(() => h.pool.acquire(1n)).toThrow(EndpointsUnavailableError)
})

// ── retired-channel reaping (idle_sweep runtime branches) ─────────────────────

let retireNode2 = async function retireNode2(
	h: EndpointPoolHarness,
	discovery: ReturnType<typeof makeFakeDiscovery>
): Promise<void> {
	h.pool.acquire(1n)
	h.pool.acquire(2n)
	discovery.push(discoveryResult([endpoint(1)])) // node 2 drops out
	h.pool.forceRediscovery()
	await settle()
}

test('idle_sweep closes a retired channel in SHUTDOWN', async (tc) => {
	let discovery = makeFakeDiscovery()
	let connections = makeFakeConnectionFactory()
	await using h = setup([endpoint(1), endpoint(2)], { discovery, connections })
	await h.pool.ready(tc.signal)
	await retireNode2(h, discovery)

	connections.byNode(2n)!.driveState(connectivityState.SHUTDOWN)
	h.machine.dispatch({ type: 'endpoints.timer.idle_sweep' })
	await settle()

	expect(connections.byNode(2n)!.closed).toBe(true)
	expect(h.pool.snapshot.byNodeId.has(2n)).toBe(false)
})

test('idle_sweep keeps a retired channel that is READY', async (tc) => {
	let discovery = makeFakeDiscovery()
	let connections = makeFakeConnectionFactory()
	await using h = setup([endpoint(1), endpoint(2)], { discovery, connections })
	await h.pool.ready(tc.signal)
	await retireNode2(h, discovery)

	connections.byNode(2n)!.driveState(connectivityState.READY)
	h.machine.dispatch({ type: 'endpoints.timer.idle_sweep' })
	await settle()

	// A working retired channel is kept so a returning node reuses it (no churn).
	expect(connections.byNode(2n)!.closed).toBe(false)
})

test('idle_sweep reaps a retired channel idle past the grace window', async (tc) => {
	let discovery = makeFakeDiscovery()
	let connections = makeFakeConnectionFactory()
	await using h = setup([endpoint(1), endpoint(2)], {
		discovery,
		connections,
		retiredGraceMs: 0, // any non-READY state is immediately past grace
	})
	await h.pool.ready(tc.signal)
	await retireNode2(h, discovery)

	connections.byNode(2n)!.driveState(connectivityState.TRANSIENT_FAILURE)
	h.machine.dispatch({ type: 'endpoints.timer.idle_sweep' })
	await settle()

	expect(connections.byNode(2n)!.closed).toBe(true)
})

// ── discovery recovery + throwing hooks ───────────────────────────────────────

test('a retryable initial failure recovers on the next successful round', async (tc) => {
	let discovery = makeFakeDiscovery()
	// A client-side UNAVAILABLE is retryable for an idempotent call (discovery is).
	discovery.fail(new ClientError('/Discovery/ListEndpoints', Status.UNAVAILABLE, 'transient'))
	discovery.push(discoveryResult([endpoint(1)])) // backoff retry succeeds
	await using h = makeEndpointPool({ discovery })

	await h.pool.ready(tc.signal)
	expect(discovery.callCount()).toBeGreaterThanOrEqual(2)
	expect(h.pool.acquire().endpoint.nodeId).toBe(1n)
})

test('a non-retryable initial failure rejects ready with the cause', async (tc) => {
	let discovery = makeFakeDiscovery()
	let boom = new TypeError('access denied')
	discovery.fail(boom)
	await using h = makeEndpointPool({ discovery })

	// A non-retryable failure is terminal; ready() rejects with the real cause,
	// not a generic 'Endpoints closed'/'finalized'.
	await expect(h.pool.ready(tc.signal)).rejects.toBe(boom)
})

test('a throwing onDiscovery hook does not break the pool', async (tc) => {
	let discovery = makeFakeDiscovery()
	// Two nodes so pessimizing one stays under the degraded threshold (no forced
	// round that would blanket-un-ban it).
	discovery.push(discoveryResult([endpoint(1), endpoint(2)]))
	await using h = makeEndpointPool({
		discovery,
		hooks: {
			onDiscovery() {
				throw new Error('hook boom')
			},
		},
	})

	await h.pool.ready(tc.signal)
	// The output loop survived the throw — a later penalize still swaps the snapshot.
	h.pool.penalize(1n)
	await settle()
	expect(h.pool.snapshot.byNodeId.get(1n)!.state).toBe('pessimized')
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

test('mapDiscoveryResult maps every PileState_State to its status', () => {
	let result = create(ListEndpointsResultSchema, {
		endpoints: [{ address: 'h1', port: 2136, nodeId: 1 }],
		pileStates: [
			{ pileName: 'a', state: PileState_State.PRIMARY },
			{ pileName: 'b', state: PileState_State.PROMOTED },
			{ pileName: 'c', state: PileState_State.SYNCHRONIZED },
			{ pileName: 'd', state: PileState_State.NOT_SYNCHRONIZED },
			{ pileName: 'e', state: PileState_State.SUSPENDED },
			{ pileName: 'f', state: PileState_State.DISCONNECTED },
			{ pileName: 'g', state: PileState_State.UNSPECIFIED },
		],
	})
	expect(mapDiscoveryResult(result).pileStates.map((p) => p.status)).toEqual([
		'PRIMARY',
		'PROMOTED',
		'SYNCHRONIZED',
		'NOT_SYNCHRONIZED',
		'SUSPENDED',
		'DISCONNECTED',
		'UNSPECIFIED',
	])
})

test('invalidate closes a materialized pinned channel', async (tc) => {
	let connections = makeFakeConnectionFactory()
	await using h = setup([endpoint(1)], { connections })
	await h.pool.ready(tc.signal)

	h.pool.pin(9n, 'node-9', 2136)
	await settle()
	h.pool.acquireNode(9n) // materialize the pinned channel
	expect(connections.byNode(9n)!.closed).toBe(false)

	h.pool.invalidate(9n)
	await settle()
	expect(connections.byNode(9n)!.closed).toBe(true)
})

test('a hung round times out and recovers on the retry', async (tc) => {
	let discovery = makeFakeDiscovery()
	discovery.hang() // first round never resolves — the per-round timeout must fire
	discovery.push(discoveryResult([endpoint(1)])) // the retry succeeds
	await using h = makeEndpointPool({ discovery, discoveryTimeoutMs: 10 })

	await h.pool.ready(tc.signal)
	expect(discovery.callCount()).toBeGreaterThanOrEqual(2)
	expect(h.pool.acquire().endpoint.nodeId).toBe(1n)
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
