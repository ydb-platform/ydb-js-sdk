import { expect, test } from 'vitest'

import type { EndpointEntry, EndpointsCtx, PileState } from './endpoints-state.ts'
import { EMPTY_SNAPSHOT, buildSnapshot, selectEndpoint } from './snapshot.ts'

let entry = function entry(nodeId: number, over: Partial<EndpointEntry> = {}): EndpointEntry {
	let e: EndpointEntry = {
		nodeId: BigInt(nodeId),
		host: `n${nodeId}`,
		port: 2136,
		address: '',
		location: 'A',
		loadFactor: 0,
		sslTargetNameOverride: '',
		ipV4: [],
		ipV6: [],
		bridgePileName: '',
		services: [],
		subState: 'active',
		generation: 0,
		...over,
	}
	e.address = over.address ?? `${e.host}:${e.port}`
	return e
}

let ctxOf = function ctxOf(
	entries: EndpointEntry[],
	over: {
		selfLocation?: string
		pileStates?: PileState[]
		localityEnabled?: boolean
		preferPrimaryPile?: boolean
		pinned?: EndpointEntry[]
	} = {}
): EndpointsCtx {
	return {
		byNodeId: new Map(entries.map((e) => [e.nodeId, e])),
		pinned: new Map((over.pinned ?? []).map((e) => [e.nodeId, e])),
		attempts: 0,
		lastError: undefined,
		roundInFlight: false,
		hasEverDiscovered: true,
		selfLocation: over.selfLocation ?? 'A',
		pileStates: over.pileStates ?? [],
		config: {
			localityEnabled: over.localityEnabled ?? false,
			preferPrimaryPile: over.preferPrimaryPile ?? false,
			degradedThreshold: 0.5,
		},
	}
}

let snap = function snap(entries: EndpointEntry[], over?: Parameters<typeof ctxOf>[1]) {
	return buildSnapshot(ctxOf(entries, over))
}

// rng that always picks the first element — makes uniform-random deterministic.
let first = () => 0

// ── buildSnapshot ────────────────────────────────────────────────────────────

test('buildSnapshot indexes every entry in byNodeId', () => {
	let s = snap([
		entry(1),
		entry(2, { subState: 'pessimized' }),
		entry(3, { subState: 'retired' }),
	])
	expect([...s.byNodeId.keys()].sort()).toEqual([1n, 2n, 3n])
})

test('buildSnapshot puts only active entries in prefer', () => {
	let s = snap([
		entry(1),
		entry(2, { subState: 'pessimized' }),
		entry(3, { subState: 'retired' }),
	])
	expect(s.prefer.map((r) => r.nodeId)).toEqual([1n])
})

test('buildSnapshot leaves fallback empty when locality is off', () => {
	let s = snap([entry(1, { location: 'A' }), entry(2, { location: 'B' })], { selfLocation: 'A' })
	expect(s.fallback).toHaveLength(0)
	expect(s.prefer.map((r) => r.nodeId).sort()).toEqual([1n, 2n])
})

test('buildSnapshot reports pileStatesPresent false for a non-bridge cluster', () => {
	expect(snap([entry(1)]).pileStatesPresent).toBe(false)
})

test('buildSnapshot reports pileStatesPresent true when pile_states is non-empty', () => {
	let s = snap([entry(1, { bridgePileName: 'p1' })], {
		pileStates: [{ pileName: 'p1', status: 'PRIMARY' }],
	})
	expect(s.pileStatesPresent).toBe(true)
})

test('buildSnapshot freezes the snapshot and its arrays', () => {
	let s = snap([entry(1)])
	expect(Object.isFrozen(s)).toBe(true)
	expect(Object.isFrozen(s.prefer)).toBe(true)
})

test('buildSnapshot carries dial fields onto the ref', () => {
	let s = snap([entry(7, { host: 'h7', port: 2140, sslTargetNameOverride: 'cn7' })])
	let r = s.byNodeId.get(7n)!
	expect(r.host).toBe('h7')
	expect(r.port).toBe(2140)
	expect(r.sslTargetNameOverride).toBe('cn7')
	expect(r.address).toBe('h7:2140')
})

// ── pile_states = identity (non-bridge) ──────────────────────────────────────

test('empty pile_states routes without any pile filter (single node)', () => {
	let r = selectEndpoint(snap([entry(1, { bridgePileName: 'whatever' })]), { rng: first })
	expect(r?.nodeId).toBe(1n)
})

test('empty pile_states keeps all active nodes routable (multi node)', () => {
	let s = snap([entry(1), entry(2), entry(3)])
	expect(s.prefer).toHaveLength(3)
})

// ── every PileState value ────────────────────────────────────────────────────

let pileCase = function pileCase(status: PileState['status'], routable: boolean) {
	test(`pile ${status} is ${routable ? 'routable' : 'excluded'}`, () => {
		let s = snap([entry(1, { bridgePileName: 'p' })], {
			pileStates: [{ pileName: 'p', status }],
		})
		expect(s.prefer.map((r) => r.nodeId)).toEqual(routable ? [1n] : [])
	})
}
pileCase('PRIMARY', true)
pileCase('PROMOTED', true)
pileCase('SYNCHRONIZED', true)
pileCase('NOT_SYNCHRONIZED', false)
pileCase('SUSPENDED', false)
pileCase('DISCONNECTED', false)
pileCase('UNSPECIFIED', false)

test('an endpoint tagged with an unknown pile is excluded', () => {
	let s = snap([entry(1, { bridgePileName: 'ghost' })], {
		pileStates: [{ pileName: 'p1', status: 'PRIMARY' }],
	})
	expect(s.prefer).toHaveLength(0)
})

test('PRIMARY-pile node is routable while a SUSPENDED-pile node is excluded', () => {
	let s = snap([entry(1, { bridgePileName: 'p1' }), entry(2, { bridgePileName: 'p2' })], {
		pileStates: [
			{ pileName: 'p1', status: 'PRIMARY' },
			{ pileName: 'p2', status: 'SUSPENDED' },
		],
	})
	expect(s.prefer.map((r) => r.nodeId)).toEqual([1n])
})

// ── affinity ─────────────────────────────────────────────────────────────────

test('affinity returns the exact active node', () => {
	let r = selectEndpoint(snap([entry(1), entry(2), entry(3)]), { preferNodeId: 2n })
	expect(r?.nodeId).toBe(2n)
})

test('affinity returns a pessimized preferred node for session binding', () => {
	let r = selectEndpoint(snap([entry(1), entry(2, { subState: 'pessimized' })]), {
		preferNodeId: 2n,
	})
	expect(r?.nodeId).toBe(2n)
	expect(r?.state).toBe('pessimized')
})

test('affinity miss falls through to balanced selection', () => {
	let r = selectEndpoint(snap([entry(1)]), { preferNodeId: 99n, rng: first })
	expect(r?.nodeId).toBe(1n)
})

// ── locality ─────────────────────────────────────────────────────────────────

test('locality prefers a local-DC node', () => {
	let s = snap([entry(1, { location: 'remote' }), entry(2, { location: 'home' })], {
		selfLocation: 'home',
		localityEnabled: true,
	})
	expect(s.prefer.map((r) => r.nodeId)).toEqual([2n])
	expect(s.fallback.map((r) => r.nodeId)).toEqual([1n])
	expect(selectEndpoint(s, { rng: first })?.nodeId).toBe(2n)
})

test('locality falls back to a remote node when no local one is active', () => {
	let s = snap([entry(1, { location: 'remote' })], {
		selfLocation: 'home',
		localityEnabled: true,
	})
	expect(s.prefer).toHaveLength(0)
	expect(selectEndpoint(s, { rng: first })?.nodeId).toBe(1n)
})

// ── preferPrimaryPile (bridge / 2DC) ─────────────────────────────────────────

let bridge = function bridge(): PileState[] {
	return [
		{ pileName: 'p1', status: 'PRIMARY' },
		{ pileName: 'p2', status: 'SYNCHRONIZED' },
	]
}

test('preferPrimaryPile puts PRIMARY-pile nodes in prefer, SYNCHRONIZED in fallback', () => {
	let s = snap([entry(1, { bridgePileName: 'p1' }), entry(2, { bridgePileName: 'p2' })], {
		pileStates: bridge(),
		preferPrimaryPile: true,
	})
	expect(s.prefer.map((r) => r.nodeId)).toEqual([1n])
	expect(s.fallback.map((r) => r.nodeId)).toEqual([2n])
	expect(selectEndpoint(s, { rng: first })?.nodeId).toBe(1n)
})

test('preferPrimaryPile treats a PROMOTED pile as primary', () => {
	let s = snap([entry(1, { bridgePileName: 'p1' })], {
		pileStates: [{ pileName: 'p1', status: 'PROMOTED' }],
		preferPrimaryPile: true,
	})
	expect(s.prefer.map((r) => r.nodeId)).toEqual([1n])
})

test('preferPrimaryPile falls back to SYNCHRONIZED when no primary node is active', () => {
	let s = snap([entry(1, { bridgePileName: 'p2' })], {
		pileStates: bridge(),
		preferPrimaryPile: true,
	})
	expect(s.prefer).toHaveLength(0)
	expect(s.fallback.map((r) => r.nodeId)).toEqual([1n])
	expect(selectEndpoint(s, { rng: first })?.nodeId).toBe(1n)
})

test('preferPrimaryPile still excludes an unusable pile', () => {
	let s = snap([entry(1, { bridgePileName: 'p1' }), entry(2, { bridgePileName: 'p3' })], {
		pileStates: [
			{ pileName: 'p1', status: 'PRIMARY' },
			{ pileName: 'p3', status: 'NOT_SYNCHRONIZED' },
		],
		preferPrimaryPile: true,
	})
	expect(s.prefer.map((r) => r.nodeId)).toEqual([1n])
	expect(s.fallback).toHaveLength(0)
})

test('preferPrimaryPile is a no-op on a non-bridge cluster', () => {
	let s = snap([entry(1), entry(2)], { preferPrimaryPile: true })
	expect(s.prefer.map((r) => r.nodeId).sort()).toEqual([1n, 2n])
	expect(s.fallback).toHaveLength(0)
})

test('preferPrimaryPile takes precedence over locality (pile axis, not location)', () => {
	// Node 1: primary pile but remote DC; node 2: synchronized pile but local DC.
	// Pile preference must win — node 1 leads despite locality pointing at node 2.
	let s = snap(
		[
			entry(1, { bridgePileName: 'p1', location: 'remote' }),
			entry(2, { bridgePileName: 'p2', location: 'home' }),
		],
		{
			selfLocation: 'home',
			pileStates: bridge(),
			localityEnabled: true,
			preferPrimaryPile: true,
		}
	)
	expect(s.prefer.map((r) => r.nodeId)).toEqual([1n])
	expect(s.fallback.map((r) => r.nodeId)).toEqual([2n])
})

// ── last resort ──────────────────────────────────────────────────────────────

test('selection falls back to a pessimized node when none are active', () => {
	let r = selectEndpoint(
		snap([entry(1, { subState: 'pessimized' }), entry(2, { subState: 'pessimized' })]),
		{ rng: first }
	)
	expect(r?.state).toBe('pessimized')
})

test('selection returns undefined when only retired nodes remain', () => {
	expect(selectEndpoint(snap([entry(1, { subState: 'retired' })]))).toBeUndefined()
})

// ── hard pin (direct-IO) ─────────────────────────────────────────────────────

test('hard-pin returns the exact pinned node', () => {
	let s = snap([], { pinned: [entry(9, { subState: 'pinned' })] })
	expect(selectEndpoint(s, { preferNodeId: 9n, hard: true })?.nodeId).toBe(9n)
})

test('hard-pin never substitutes a different node', () => {
	let s = snap([entry(1)], { pinned: [entry(9, { subState: 'pinned' })] })
	expect(selectEndpoint(s, { preferNodeId: 42n, hard: true })).toBeUndefined()
})

test('hard-pin without a preferNodeId returns undefined', () => {
	expect(selectEndpoint(snap([entry(1)]), { hard: true })).toBeUndefined()
})

test('a pinned node is reachable by affinity even when absent from discovery', () => {
	let s = snap([entry(1)], { pinned: [entry(9, { subState: 'pinned' })] })
	expect(selectEndpoint(s, { preferNodeId: 9n })?.nodeId).toBe(9n)
})

// ── zero connections ─────────────────────────────────────────────────────────

test('selection on an empty snapshot returns undefined', () => {
	expect(selectEndpoint(snap([]))).toBeUndefined()
})

test('selection on EMPTY_SNAPSHOT returns undefined', () => {
	expect(selectEndpoint(EMPTY_SNAPSHOT)).toBeUndefined()
})

// ── uniform random ───────────────────────────────────────────────────────────

test('uniform random selects by the injected rng index', () => {
	let s = snap([entry(1), entry(2), entry(3)])
	expect(selectEndpoint(s, { rng: () => 0 })?.nodeId).toBe(1n)
	expect(selectEndpoint(s, { rng: () => 0.5 })?.nodeId).toBe(2n)
	expect(selectEndpoint(s, { rng: () => 0.99 })?.nodeId).toBe(3n)
})
