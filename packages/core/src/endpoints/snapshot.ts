// The immutable routing snapshot (RCU value) and the pure selection cascade.
// No FSM, no gRPC — this is the module the synchronous facade reads on every
// RPC, and the one that carries the heaviest unit coverage.

import type { EndpointEntry, EndpointsCtx, PileStatus } from './endpoints-state.js'

// Piles a client may route to. Others are excluded before locality/load.
export const USABLE_PILE_STATUSES: ReadonlySet<PileStatus> = new Set<PileStatus>([
	'PRIMARY',
	'PROMOTED',
	'SYNCHRONIZED',
])

export type EndpointRefState = 'active' | 'pessimized' | 'retired' | 'pinned'

// Frozen routing + dial metadata. Carries everything the facade needs to
// lazily materialize a channel on first selection, so the sync hot path never
// reaches into the (mutable) FSM context.
export type EndpointRef = Readonly<{
	nodeId: bigint
	// 'host:port' — routing key, diagnostics, logs.
	address: string
	// Raw dial fields.
	host: string
	port: number
	sslTargetNameOverride: string
	ipV4: readonly string[]
	ipV6: readonly string[]
	location: string
	pile: string
	state: EndpointRefState
}>

export type RoutingSnapshot = Readonly<{
	// Every discovered node (incl. pessimized/retired) — the affinity target set.
	byNodeId: ReadonlyMap<bigint, EndpointRef>
	// Healthy, pile-ok, local (or ALL healthy when locality is off).
	prefer: readonly EndpointRef[]
	// Healthy, pile-ok, remote (empty when locality is off).
	fallback: readonly EndpointRef[]
	// Direct-IO pins — outside prefer/fallback balancing.
	pinned: ReadonlyMap<bigint, EndpointRef>
	selfLocation: string
	// false ⇒ the pile filter was identity (non-bridge cluster).
	pileStatesPresent: boolean
}>

export type SelectOptions = {
	preferNodeId?: bigint
	// Direct-IO: this exact node or nothing (never balance to a substitute).
	hard?: boolean
	// Injectable for deterministic model/unit tests; Math.random in production.
	rng?: () => number
}

export const EMPTY_SNAPSHOT: RoutingSnapshot = Object.freeze({
	byNodeId: new Map<bigint, EndpointRef>(),
	prefer: Object.freeze([]),
	fallback: Object.freeze([]),
	pinned: new Map<bigint, EndpointRef>(),
	selfLocation: '',
	pileStatesPresent: false,
})

let ref = function ref(entry: EndpointEntry): EndpointRef {
	return Object.freeze({
		nodeId: entry.nodeId,
		address: entry.address,
		host: entry.host,
		port: entry.port,
		sslTargetNameOverride: entry.sslTargetNameOverride,
		ipV4: Object.freeze(entry.ipV4.slice()),
		ipV6: Object.freeze(entry.ipV6.slice()),
		location: entry.location,
		pile: entry.bridgePileName,
		state: entry.subState as EndpointRefState,
	})
}

// Rebuild the immutable snapshot from the pure context. Applies the pile-health
// filter BEFORE locality; keeps pessimized/retired in byNodeId (affinity) but
// out of prefer/fallback.
export let buildSnapshot = function buildSnapshot(ctx: EndpointsCtx): RoutingSnapshot {
	let present = ctx.pileStates.length > 0

	let pileHealthy = function pileHealthy(pile: string): boolean {
		if (!present) return true // identity: non-bridge cluster
		let found = ctx.pileStates.find((p) => p.pileName === pile)
		return found !== undefined && USABLE_PILE_STATUSES.has(found.status)
	}

	let byNodeId = new Map<bigint, EndpointRef>()
	let prefer: EndpointRef[] = []
	let fallback: EndpointRef[] = []

	for (let entry of ctx.byNodeId.values()) {
		let r = ref(entry)
		byNodeId.set(entry.nodeId, r)

		let routable = entry.subState === 'active' && pileHealthy(entry.bridgePileName)
		if (!routable) continue

		if (!ctx.config.localityEnabled) {
			prefer.push(r)
		} else if (entry.location === ctx.selfLocation) {
			prefer.push(r)
		} else {
			fallback.push(r)
		}
	}

	let pinned = new Map<bigint, EndpointRef>()
	for (let entry of ctx.pinned.values()) {
		let r = ref(entry)
		pinned.set(entry.nodeId, r)
		// A pinned node not present in discovery is still reachable by affinity.
		if (!byNodeId.has(entry.nodeId)) byNodeId.set(entry.nodeId, r)
	}

	return Object.freeze({
		byNodeId,
		prefer: Object.freeze(prefer),
		fallback: Object.freeze(fallback),
		pinned,
		selfLocation: ctx.selfLocation,
		pileStatesPresent: present,
	})
}

let pick = function pick(arr: readonly EndpointRef[], rng: () => number): EndpointRef | undefined {
	if (arr.length === 0) return undefined
	return arr[Math.floor(rng() * arr.length)]
}

let filterByState = function filterByState(
	snapshot: RoutingSnapshot,
	state: EndpointRefState
): EndpointRef[] {
	let out: EndpointRef[] = []
	for (let r of snapshot.byNodeId.values()) {
		if (r.state === state) out.push(r)
	}
	return out
}

// The selection cascade. The pile filter is already baked into prefer/fallback
// at build time (empty pile_states ⇒ identity), so no pile logic here.
//
//   (0) hard-pin      — direct-IO, exact node or undefined (never substitutes)
//   (1) soft affinity — node-bound sessions; returns even a pessimized/retired
//                       node so a bound session errors explicitly rather than
//                       silently landing on the wrong node
//   (2) healthy prefer (local, or all-healthy when locality off) — uniform random
//   (3) healthy fallback (remote) — uniform random
//   (4) any active, pile-relaxed — last resort before pessimized
//   (5) pessimized — last resort
//   (6) undefined — zero connections (facade throws)
export let selectEndpoint = function selectEndpoint(
	snapshot: RoutingSnapshot,
	opts: SelectOptions = {}
): EndpointRef | undefined {
	let rng = opts.rng ?? Math.random

	if (opts.hard) {
		if (opts.preferNodeId === undefined) return undefined
		return snapshot.pinned.get(opts.preferNodeId) ?? snapshot.byNodeId.get(opts.preferNodeId)
	}

	if (opts.preferNodeId !== undefined) {
		let hit = snapshot.byNodeId.get(opts.preferNodeId)
		if (hit !== undefined) return hit
	}

	let preferred = pick(snapshot.prefer, rng)
	if (preferred !== undefined) return preferred

	let remote = pick(snapshot.fallback, rng)
	if (remote !== undefined) return remote

	let anyActive = pick(filterByState(snapshot, 'active'), rng)
	if (anyActive !== undefined) return anyActive

	let pessimized = pick(filterByState(snapshot, 'pessimized'), rng)
	if (pessimized !== undefined) return pessimized

	return undefined
}
