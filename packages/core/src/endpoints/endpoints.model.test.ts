import { expect, test } from 'vitest'

import {
	type DiscoveredEndpoint,
	type EndpointsCtx,
	type EndpointsEvent,
	type EndpointsOutput,
	type EndpointsState,
	type PileState,
	type PileStatus,
	createEndpointsCtx,
	endpointsTransition,
} from './endpoints-state.ts'
import { buildSnapshot, selectEndpoint } from './snapshot.ts'

// Deterministic PRNG — reproducible failures cite the seed.
let mulberry32 = function mulberry32(a: number): () => number {
	return () => {
		a |= 0
		a = (a + 0x6d2b79f5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

let pick = function pick<T>(rng: () => number, arr: T[]): T | undefined {
	if (arr.length === 0) return undefined
	return arr[Math.floor(rng() * arr.length)]
}

let PILE_STATUSES: PileStatus[] = [
	'PRIMARY',
	'SYNCHRONIZED',
	'SUSPENDED',
	'DISCONNECTED',
	'NOT_SYNCHRONIZED',
]
let LOCATIONS = ['A', 'B', 'C']

type Sim = {
	ctx: EndpointsCtx
	state: EndpointsState
	closed: boolean
}

let apply = function apply(sim: Sim, event: EndpointsEvent): void {
	let runtime = {
		state: sim.state,
		signal: new AbortController().signal,
		emit: (_o: EndpointsOutput) => {},
		dispatch: (_e: EndpointsEvent) => {},
	}
	let result = endpointsTransition(sim.ctx, event, runtime)
	if (result?.state !== undefined) sim.state = result.state
	if (sim.state === 'closed') sim.closed = true
}

let randomRound = function randomRound(rng: () => number): EndpointsEvent {
	let bridge = rng() < 0.5
	let endpoints: DiscoveredEndpoint[] = []
	let pileNames = ['p1', 'p2']
	for (let nodeId = 1; nodeId <= 5; nodeId++) {
		if (rng() < 0.6) {
			endpoints.push({
				nodeId: BigInt(nodeId),
				host: `n${nodeId}`,
				port: 2136,
				location: pick(rng, LOCATIONS)!,
				loadFactor: 0,
				sslTargetNameOverride: '',
				ipV4: [],
				ipV6: [],
				bridgePileName: bridge ? pick(rng, pileNames)! : '',
				services: [],
			})
		}
	}
	let pileStates: PileState[] = bridge
		? pileNames.map((pileName) => ({ pileName, status: pick(rng, PILE_STATUSES)! }))
		: []
	return {
		type: 'endpoints.discovery.round_succeeded',
		endpoints,
		selfLocation: pick(rng, LOCATIONS)!,
		pileStates,
	}
}

let checkInvariants = function checkInvariants(sim: Sim, seed: number, stepIndex: number): void {
	let ctx = sim.ctx
	let label = `seed=${seed} step=${stepIndex} state=${sim.state}`

	let activeCount = 0
	let pessimizedCount = 0
	for (let entry of ctx.byNodeId.values()) {
		expect(['active', 'pessimized', 'retired'], label).toContain(entry.subState)
		if (entry.subState === 'active') activeCount++
		else if (entry.subState === 'pessimized') pessimizedCount++
	}

	let snapshot = buildSnapshot(ctx)

	// The precomputed count must always match the actual pessimized set.
	expect(snapshot.pessimizedCount, `${label} pessimizedCount`).toBe(pessimizedCount)

	// Every discovered node is reachable by affinity.
	for (let nodeId of ctx.byNodeId.keys()) {
		expect(snapshot.byNodeId.has(nodeId), `${label} affinity ${nodeId}`).toBe(true)
	}

	// Snapshot never strands: if any node can serve, selection must return one.
	if (activeCount + pessimizedCount > 0) {
		expect(selectEndpoint(snapshot, { rng: () => 0 }), `${label} strand`).toBeDefined()
	} else {
		expect(selectEndpoint(snapshot, { rng: () => 0 }), `${label} empty`).toBeUndefined()
	}

	// Affinity to a pessimized node still resolves (session binding).
	for (let [nodeId, entry] of ctx.byNodeId) {
		if (entry.subState === 'pessimized') {
			expect(
				selectEndpoint(snapshot, { preferNodeId: nodeId })?.nodeId,
				`${label} bind ${nodeId}`
			).toBe(nodeId)
		}
	}

	// Health state tracks the pessimized fraction: degraded iff ratio > threshold.
	if (sim.state === 'ready' || sim.state === 'degraded') {
		let total = activeCount + pessimizedCount
		let ratio = total === 0 ? 0 : pessimizedCount / total
		let expected = ratio > ctx.config.degradedThreshold ? 'degraded' : 'ready'
		expect(sim.state, `${label} health ratio=${ratio}`).toBe(expected)
	}
}

let runOne = function runOne(seed: number, steps: number): void {
	let rng = mulberry32(seed)
	let sim: Sim = {
		ctx: createEndpointsCtx({ localityEnabled: rng() < 0.5 }),
		state: 'idle',
		closed: false,
	}

	apply(sim, { type: 'endpoints.discovery.start' })
	apply(sim, randomRound(rng))

	for (let stepIndex = 0; stepIndex < steps; stepIndex++) {
		if (sim.closed) break
		let nodeIds = [...sim.ctx.byNodeId.keys()]
		let retiredIds = nodeIds.filter((id) => sim.ctx.byNodeId.get(id)!.subState === 'retired')
		let pinnedIds = [...sim.ctx.pinned.keys()]
		let roll = rng()

		if (roll < 0.3) {
			apply(sim, randomRound(rng))
		} else if (roll < 0.5) {
			let id = pick(rng, nodeIds)
			if (id !== undefined) apply(sim, { type: 'endpoints.rpc_failed', nodeId: id })
		} else if (roll < 0.65) {
			let id = pick(rng, nodeIds)
			if (id !== undefined) apply(sim, { type: 'endpoints.rpc_ok', nodeId: id })
		} else if (roll < 0.72) {
			apply(sim, { type: 'endpoints.discovery.force' })
		} else if (roll < 0.8) {
			let id = pick(rng, retiredIds)
			if (id !== undefined) apply(sim, { type: 'endpoints.channel_closeable', nodeId: id })
		} else if (roll < 0.88) {
			let nodeId = BigInt(6 + Math.floor(rng() * 4))
			apply(sim, {
				type: 'endpoints.pin',
				nodeId,
				host: `p${nodeId}`,
				port: 2136,
				location: '',
				sslTargetNameOverride: '',
				ipV4: [],
				ipV6: [],
				generation: stepIndex,
			})
		} else if (roll < 0.94) {
			let id = pick(rng, pinnedIds)
			if (id !== undefined) apply(sim, { type: 'endpoints.invalidate', nodeId: id })
		} else if (roll < 0.97) {
			// A background round can succeed or fail.
			if (rng() < 0.5) apply(sim, randomRound(rng))
			else
				apply(sim, {
					type: 'endpoints.discovery.round_failed',
					error: new Error('transient'),
					retryable: true,
				})
		} else if (roll < 0.985) {
			// Occasionally close/destroy — the walk ends; assert terminal invariants.
			apply(sim, rng() < 0.5 ? { type: 'endpoints.close' } : { type: 'endpoints.destroy' })
		}

		if (sim.closed) {
			// A closed machine ignores every further event and never routes.
			apply(sim, { type: 'endpoints.rpc_failed', nodeId: 1n })
			expect(sim.state, `seed=${seed} step=${stepIndex} closed`).toBe('closed')
			break
		}
		checkInvariants(sim, seed, stepIndex)
	}
}

test('endpoints FSM upholds routing invariants across 300 random seeds', () => {
	let runs = 0
	for (let seed = 1; seed <= 300; seed++) {
		runOne(seed, 40)
		runs++
	}
	expect(runs).toBe(300)
})

test('a clean round converges the FSM to ready with no round in flight', () => {
	let sim: Sim = { ctx: createEndpointsCtx(), state: 'idle', closed: false }
	apply(sim, { type: 'endpoints.discovery.start' })
	apply(sim, {
		type: 'endpoints.discovery.round_succeeded',
		endpoints: [
			{
				nodeId: 1n,
				host: 'n1',
				port: 2136,
				location: 'A',
				loadFactor: 0,
				sslTargetNameOverride: '',
				ipV4: [],
				ipV6: [],
				bridgePileName: '',
				services: [],
			},
		],
		selfLocation: 'A',
		pileStates: [],
	})
	expect(sim.state).toBe('ready')
	expect(sim.ctx.roundInFlight).toBe(false)
})
