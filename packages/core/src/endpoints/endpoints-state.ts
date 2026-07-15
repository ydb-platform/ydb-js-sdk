// The pure half of the endpoints engine: states, context, and a synchronous
// transition with no I/O. All timers, gRPC channels, discovery calls, and the
// clock live in the effectful half (`endpoints-runtime.ts`).
//
// One machine owns the DISCOVERY lifecycle (idle → discovering → ready →
// degraded → closing → closed). Per-endpoint HEALTH is not a machine state —
// it is a sub-state on a registry entry (like the topic reader's PartitionEntry),
// so a 10k-node cluster stays a single machine with two maps, not 10k machines.
//
// The transition rebuilds an immutable RoutingSnapshot (RCU) and emits it as an
// output whenever the routable set changes. The synchronous facade reads that
// snapshot per-RPC without dispatching — see `endpoints-runtime.ts`.
//
// The full transition table lives in packages/core/ARCHITECTURE.md and must be
// updated in the same commit as this dispatch.

import type { TransitionResult, TransitionRuntime } from '@ydbjs/fsm'

import { EMPTY_SNAPSHOT, buildSnapshot } from './snapshot.js'
import type { RoutingSnapshot } from './snapshot.js'

// ── Bridge / multi-pile (2-DC) ──────────────────────────────────────────────
// The generated @ydbjs/api discovery proto carries `pile_states` /
// `bridge_pile_name` (see @ydbjs/api/bridge). The runtime maps proto → DTO; a
// non-bridge cluster returns empty `pile_states`, which `buildSnapshot` treats
// as identity (no pile filter). Bridge clusters filter to usable pile statuses.
export type PileStatus =
	| 'PRIMARY'
	| 'PROMOTED'
	| 'SYNCHRONIZED'
	| 'NOT_SYNCHRONIZED'
	| 'SUSPENDED'
	| 'DISCONNECTED'
	| 'UNSPECIFIED'

export type PileState = {
	pileName: string
	status: PileStatus
}

// ── Endpoint model (full server-field coverage) ─────────────────────────────
// The domain view the runtime hands the FSM — a superset of the current proto
// EndpointInfo plus the forward-looking bridge field. `loadFactor` is carried
// for observability only; it is never used for routing (the server hardcodes
// it to 0.0 today).
export type DiscoveredEndpoint = {
	nodeId: bigint
	// Raw host (proto EndpointInfo.address), used for dialing.
	host: string
	port: number
	location: string
	loadFactor: number
	sslTargetNameOverride: string
	ipV4: string[]
	ipV6: string[]
	bridgePileName: string
	services: string[]
}

export type EndpointSubState = 'active' | 'pessimized' | 'retired' | 'pinned'

// Registry record. Mutated synchronously inside the transition only. No clock
// fields (timestamps are runtime concerns) so the transition stays pure and
// model-testable.
export type EndpointEntry = {
	nodeId: bigint
	// Raw host for dialing (proto EndpointInfo.address).
	host: string
	port: number
	// 'host:port' — used for routing keys, diagnostics, and logs (parity with conn.ts).
	address: string
	location: string
	loadFactor: number
	sslTargetNameOverride: string
	ipV4: string[]
	ipV6: string[]
	bridgePileName: string
	services: string[]
	subState: EndpointSubState
	// Bumped every time a pinned entry is (re)pinned; 0 for discovered entries.
	generation: number
}

// Lightweight endpoint identity used in outputs (parity with hooks.EndpointInfo).
export type EndpointInfoLite = {
	nodeId: bigint
	address: string
	location: string
}

export type EndpointsConfig = {
	// Locality is OPT-IN and soft-only: it only reorders prefer/fallback tiers,
	// never hard-pins to the local DC.
	localityEnabled: boolean
	// Force rediscovery when the pessimized fraction exceeds this (0..1).
	degradedThreshold: number
}

// Pure logical context — flags, counters, ids, and the two registries. No I/O
// handles, no timers, no clock.
export type EndpointsCtx = {
	byNodeId: Map<bigint, EndpointEntry>
	pinned: Map<bigint, EndpointEntry>

	attempts: number
	lastError: unknown
	roundInFlight: boolean
	hasEverDiscovered: boolean

	selfLocation: string
	// Empty ⇒ the cluster is not in bridge mode ⇒ the pile filter is identity.
	pileStates: PileState[]

	config: EndpointsConfig
}

export const DEFAULT_DEGRADED_THRESHOLD = 0.5

export let createEndpointsCtx = function createEndpointsCtx(config?: {
	localityEnabled?: boolean | undefined
	degradedThreshold?: number | undefined
}): EndpointsCtx {
	return {
		byNodeId: new Map(),
		pinned: new Map(),
		attempts: 0,
		lastError: undefined,
		roundInFlight: false,
		hasEverDiscovered: false,
		selfLocation: '',
		pileStates: [],
		config: {
			localityEnabled: config?.localityEnabled ?? false,
			degradedThreshold: config?.degradedThreshold ?? DEFAULT_DEGRADED_THRESHOLD,
		},
	}
}

// ── States ──────────────────────────────────────────────────────────────────
export type EndpointsState = 'idle' | 'discovering' | 'ready' | 'degraded' | 'closing' | 'closed'

// ── Timers ──────────────────────────────────────────────────────────────────
// No per-endpoint pessimization timer: recovery is optimistic-un-ban-on-rpc-ok
// plus blanket-un-ban-on-discovery. `idle_sweep` reaps genuinely-departed
// retired channels; brief flaps are absorbed (see endpoints-runtime.ts).
export type TimerName = 'discovery_interval' | 'discovery_backoff' | 'idle_sweep' | 'close_deadline'
export type TimerRef = { which: TimerName }

// ── Events ──────────────────────────────────────────────────────────────────
export type EndpointsEvent =
	| { type: 'endpoints.discovery.start' }
	| { type: 'endpoints.discovery.force' }
	| {
			type: 'endpoints.discovery.round_succeeded'
			endpoints: DiscoveredEndpoint[]
			selfLocation: string
			pileStates: PileState[]
	  }
	| { type: 'endpoints.discovery.round_failed'; error: unknown; retryable: boolean }
	// Per-RPC outcomes (the only per-RPC dispatch; cheap enqueue).
	| { type: 'endpoints.rpc_failed'; nodeId: bigint }
	| { type: 'endpoints.rpc_ok'; nodeId: bigint }
	// Direct-IO pins (server-named node_ids possibly outside ListEndpoints).
	| {
			type: 'endpoints.pin'
			nodeId: bigint
			host: string
			port: number
			location: string
			sslTargetNameOverride: string
			ipV4: string[]
			ipV6: string[]
			generation: number
	  }
	| { type: 'endpoints.invalidate'; nodeId: bigint }
	// The runtime observed a channel become closeable (drained / broken / past
	// grace, or fully drained during close) and asks the FSM to drop it. During
	// closing, dropping the last channel finalizes.
	| { type: 'endpoints.channel_closeable'; nodeId: bigint }
	| { type: 'endpoints.timer.discovery_interval' }
	| { type: 'endpoints.timer.discovery_backoff' }
	| { type: 'endpoints.timer.idle_sweep' }
	| { type: 'endpoints.timer.close_deadline' }
	| { type: 'endpoints.close' }
	| { type: 'endpoints.destroy'; reason?: unknown }

// ── Effects ─────────────────────────────────────────────────────────────────
export type EndpointsEffect =
	| { type: 'endpoints.effect.run_discovery_round' }
	| ({ type: 'endpoints.effect.timer.schedule' } & TimerRef)
	| ({ type: 'endpoints.effect.timer.clear' } & TimerRef)
	// Retire-to-drain: keep the channel open, move it to the drain-watch set.
	| { type: 'endpoints.effect.retire_channel'; nodeId: bigint }
	// Physically close and drop the channel. `store` scopes which materialized
	// channel is dropped: 'pinned' closes only the pin (an invalidate must not
	// tear down a discovered channel that shares the same nodeId); 'any' (default)
	// closes whichever store holds it.
	| { type: 'endpoints.effect.close_channel'; nodeId: bigint; store?: 'any' | 'pinned' }
	// Begin the graceful close drain: close idle channels now and wait for
	// in-flight streams to finish (bounded by the close deadline). Runtime-only.
	| { type: 'endpoints.effect.begin_close_drain' }
	// Scan retired channels; dispatch endpoints.channel_closeable for any that
	// are genuinely gone (broken or idle past grace). Pure I/O in the runtime.
	| { type: 'endpoints.effect.idle_sweep' }
	| { type: 'endpoints.effect.finalize'; reason: unknown }

// ── Outputs ─────────────────────────────────────────────────────────────────
export type EndpointsOutput =
	| { type: 'endpoints.snapshot'; snapshot: RoutingSnapshot }
	| { type: 'endpoints.ready' }
	| {
			type: 'endpoints.discovery_completed'
			added: EndpointInfoLite[]
			removed: EndpointInfoLite[]
			total: number
			selfLocation: string
	  }
	| { type: 'endpoints.discovery_failed'; error: unknown; attempt: number; retryable: boolean }
	| { type: 'endpoints.added'; nodeId: bigint; address: string; location: string }
	| { type: 'endpoints.pessimized'; nodeId: bigint; address: string; location: string }
	| { type: 'endpoints.unpessimized'; nodeId: bigint; address: string; location: string }
	| {
			type: 'endpoints.retired'
			nodeId: bigint
			address: string
			location: string
			reason: 'stale_active' | 'stale_pessimized'
	  }
	| {
			type: 'endpoints.removed'
			nodeId: bigint
			address: string
			location: string
			reason: 'idle' | 'pool_close'
	  }
	| { type: 'endpoints.failed'; error: unknown }
	| { type: 'endpoints.closed'; reason?: unknown }

// The transition-layer runtime handle (state + emit/dispatch). Named distinctly
// from the `EndpointsRuntime` facade in endpoints-runtime.ts to avoid a shadow;
// internal to this module.
type EndpointsTransitionRuntime = TransitionRuntime<EndpointsState, EndpointsEvent, EndpointsOutput>
type Result = TransitionResult<EndpointsState, EndpointsEffect>

// ── Pure helpers ────────────────────────────────────────────────────────────

let entryFrom = function entryFrom(
	ep: DiscoveredEndpoint,
	subState: EndpointSubState,
	generation: number
): EndpointEntry {
	return {
		nodeId: ep.nodeId,
		host: ep.host,
		port: ep.port,
		address: `${ep.host}:${ep.port}`,
		location: ep.location,
		loadFactor: ep.loadFactor,
		sslTargetNameOverride: ep.sslTargetNameOverride,
		ipV4: ep.ipV4,
		ipV6: ep.ipV6,
		bridgePileName: ep.bridgePileName,
		services: ep.services,
		subState,
		generation,
	}
}

// Fraction of routable (active + pessimized) nodes that are pessimized. Retired
// and pinned entries are excluded from the denominator.
let pessimizedRatio = function pessimizedRatio(ctx: EndpointsCtx): number {
	let active = 0
	let pessimized = 0
	for (let entry of ctx.byNodeId.values()) {
		if (entry.subState === 'active') active++
		else if (entry.subState === 'pessimized') pessimized++
	}
	let total = active + pessimized
	return total === 0 ? 0 : pessimized / total
}

let healthState = function healthState(ctx: EndpointsCtx): EndpointsState {
	return pessimizedRatio(ctx) > ctx.config.degradedThreshold ? 'degraded' : 'ready'
}

let rebuild = function rebuild(ctx: EndpointsCtx, runtime: EndpointsTransitionRuntime): void {
	runtime.emit({ type: 'endpoints.snapshot', snapshot: buildSnapshot(ctx) })
}

let ignored = function ignored(): void {
	// Unhandled (state, event) pair — no-op. Kept explicit for the table.
}

export type RetiredInfo = EndpointInfoLite & { reason: 'stale_active' | 'stale_pessimized' }

export type RoundDiff = {
	// New OR revived (a retired node reappearing) — both reported as `added` so
	// the add/remove event streams stay balanced.
	added: EndpointInfoLite[]
	// Vanished from discovery while still active/pessimized — reported as `retired`.
	retired: RetiredInfo[]
}

// The single source of the round-diff rule. Shared by `applyRound` (which emits
// the FSM's per-node outputs) and the runtime's `publishRoundDiagnostics` (which
// publishes the same events inside the discovery span; it runs before applyRound,
// so it cannot reuse applyRound's result). Pure — computed against the PRE-round
// registry, mutates nothing.
export let computeRoundDiff = function computeRoundDiff(
	byNodeId: ReadonlyMap<bigint, EndpointEntry>,
	endpoints: DiscoveredEndpoint[]
): RoundDiff {
	let discovered = new Set<bigint>()
	let added: EndpointInfoLite[] = []
	for (let ep of endpoints) {
		// A degenerate response may repeat a nodeId — classify the first
		// occurrence only, so `added` never double-counts a node.
		if (discovered.has(ep.nodeId)) continue
		discovered.add(ep.nodeId)
		let existing = byNodeId.get(ep.nodeId)
		if (existing === undefined || existing.subState === 'retired') {
			added.push({
				nodeId: ep.nodeId,
				address: `${ep.host}:${ep.port}`,
				location: ep.location,
			})
		}
	}

	let retired: RetiredInfo[] = []
	for (let entry of byNodeId.values()) {
		if (discovered.has(entry.nodeId) || entry.subState === 'retired') continue
		retired.push({
			nodeId: entry.nodeId,
			address: entry.address,
			location: entry.location,
			reason: entry.subState === 'pessimized' ? 'stale_pessimized' : 'stale_active',
		})
	}

	return { added, retired }
}

// An empty endpoint list is never a usable cluster view — applying it would wipe
// routing (initially: ready() resolves with nothing routable; in steady state:
// every node retires and balanced acquire() throws until the next interval).
// Reject it as a retryable round failure in EVERY state: keep the last snapshot
// and registry untouched, arm the backoff.
let rejectEmptyRound = function rejectEmptyRound(
	ctx: EndpointsCtx,
	runtime: EndpointsTransitionRuntime
): Result {
	ctx.attempts += 1
	ctx.roundInFlight = false
	runtime.emit({
		type: 'endpoints.discovery_failed',
		error: new Error('discovery returned no endpoints'),
		attempt: ctx.attempts,
		retryable: true,
	})
	return {
		effects: [{ type: 'endpoints.effect.timer.schedule', which: 'discovery_backoff' }],
	}
}

// Apply a fresh discovery result to the registry. Returns the effects to run
// (retire_channel for newly-stale nodes) and emits per-node outputs. Subsumes
// pool.sync() with the retire-reappear fix. The add/retire classification comes
// from `computeRoundDiff`; the loop below only mutates the registry.
let applyRound = function applyRound(
	ctx: EndpointsCtx,
	endpoints: DiscoveredEndpoint[],
	selfLocation: string,
	pileStates: PileState[],
	runtime: EndpointsTransitionRuntime
): EndpointsEffect[] {
	let { added, retired } = computeRoundDiff(ctx.byNodeId, endpoints)
	let effects: EndpointsEffect[] = []

	// Mutate: add new entries, revive retired, un-ban pessimized, refresh dial info.
	for (let ep of endpoints) {
		let existing = ctx.byNodeId.get(ep.nodeId)
		if (existing === undefined) {
			ctx.byNodeId.set(ep.nodeId, entryFrom(ep, 'active', 0))
			continue
		}

		// A same-nodeId re-registration at a different host:port means the old
		// channel dials a dead address — drop it so the next acquire re-dials.
		// (A brief flap keeps the same address and is absorbed by retire-drain.)
		let newAddress = `${ep.host}:${ep.port}`
		if (existing.address !== newAddress) {
			effects.push({ type: 'endpoints.effect.close_channel', nodeId: ep.nodeId })
		}

		// Refresh surface fields (location/pile/load/dial info can change).
		existing.host = ep.host
		existing.port = ep.port
		existing.address = newAddress
		existing.location = ep.location
		existing.loadFactor = ep.loadFactor
		existing.sslTargetNameOverride = ep.sslTargetNameOverride
		existing.ipV4 = ep.ipV4
		existing.ipV6 = ep.ipV6
		existing.bridgePileName = ep.bridgePileName
		existing.services = ep.services

		if (existing.subState === 'retired') {
			// Revive in place — keep the draining channel (never close+recreate,
			// that would kill live streams). Reported as `added` by the diff.
			existing.subState = 'active'
		} else if (existing.subState === 'pessimized') {
			// Blanket un-ban on discovery (authoritative recovery). Not an `added`.
			existing.subState = 'active'
			runtime.emit({
				type: 'endpoints.unpessimized',
				nodeId: existing.nodeId,
				address: existing.address,
				location: existing.location,
			})
		}
	}

	// Retire the vanished endpoints from the diff. Channel stays open to drain.
	for (let r of retired) {
		ctx.byNodeId.get(r.nodeId)!.subState = 'retired'
		effects.push({ type: 'endpoints.effect.retire_channel', nodeId: r.nodeId })
	}

	// Emit the add/retire outputs from the single-sourced diff.
	for (let a of added) {
		runtime.emit({
			type: 'endpoints.added',
			nodeId: a.nodeId,
			address: a.address,
			location: a.location,
		})
	}
	for (let r of retired) {
		runtime.emit({
			type: 'endpoints.retired',
			nodeId: r.nodeId,
			address: r.address,
			location: r.location,
			reason: r.reason,
		})
	}

	ctx.selfLocation = selfLocation
	ctx.pileStates = pileStates
	ctx.attempts = 0
	ctx.lastError = undefined
	ctx.roundInFlight = false

	rebuild(ctx, runtime)
	runtime.emit({
		type: 'endpoints.discovery_completed',
		added,
		removed: retired.map((r) => ({
			nodeId: r.nodeId,
			address: r.address,
			location: r.location,
		})),
		total: endpoints.length,
		selfLocation,
	})

	return effects
}

let toClosing = function toClosing(ctx: EndpointsCtx, runtime: EndpointsTransitionRuntime): Result {
	// Nothing registered → finalize immediately (no channels can exist).
	if (ctx.byNodeId.size === 0 && ctx.pinned.size === 0) {
		return terminate(ctx, new Error('Endpoints closed'), runtime)
	}

	// Freeze routing so no new RPC is dialed while draining, then hand the drain
	// to the runtime: `begin_close_drain` closes idle channels immediately and
	// dispatches `drained` once in-flight streams finish; `close_deadline` is the
	// hard cap that force-closes whatever is left. This avoids waiting the full
	// deadline when there is nothing (or nothing busy) to drain.
	runtime.emit({ type: 'endpoints.snapshot', snapshot: EMPTY_SNAPSHOT })
	return {
		state: 'closing',
		effects: [
			{ type: 'endpoints.effect.timer.clear', which: 'discovery_interval' },
			{ type: 'endpoints.effect.timer.clear', which: 'discovery_backoff' },
			{ type: 'endpoints.effect.timer.clear', which: 'idle_sweep' },
			{ type: 'endpoints.effect.begin_close_drain' },
			{ type: 'endpoints.effect.timer.schedule', which: 'close_deadline' },
		],
	}
}

let terminate = function terminate(
	ctx: EndpointsCtx,
	reason: unknown,
	runtime: EndpointsTransitionRuntime,
	failure?: unknown
): Result {
	if (failure !== undefined) {
		runtime.emit({ type: 'endpoints.failed', error: failure })
	}

	let effects: EndpointsEffect[] = []
	for (let entry of ctx.byNodeId.values()) {
		runtime.emit({
			type: 'endpoints.removed',
			nodeId: entry.nodeId,
			address: entry.address,
			location: entry.location,
			reason: 'pool_close',
		})
		effects.push({ type: 'endpoints.effect.close_channel', nodeId: entry.nodeId })
	}
	for (let entry of ctx.pinned.values()) {
		effects.push({ type: 'endpoints.effect.close_channel', nodeId: entry.nodeId })
	}

	// Empty the read plane: a post-close acquire() then selects nothing and throws
	// instead of vending a fresh channel no one will ever close.
	runtime.emit({ type: 'endpoints.snapshot', snapshot: EMPTY_SNAPSHOT })
	runtime.emit({ type: 'endpoints.closed', reason })

	ctx.byNodeId.clear()
	ctx.pinned.clear()
	ctx.roundInFlight = false

	return {
		state: 'closed',
		final: { reason },
		effects: [
			...effects,
			{ type: 'endpoints.effect.timer.clear', which: 'discovery_interval' },
			{ type: 'endpoints.effect.timer.clear', which: 'discovery_backoff' },
			{ type: 'endpoints.effect.timer.clear', which: 'idle_sweep' },
			{ type: 'endpoints.effect.timer.clear', which: 'close_deadline' },
			{ type: 'endpoints.effect.finalize', reason },
		],
	}
}

// Handle a pin/invalidate uniformly across live states. Returns a rebuild result
// when the pinned set changed, else void.
let applyPin = function applyPin(
	ctx: EndpointsCtx,
	event: Extract<EndpointsEvent, { type: 'endpoints.pin' }>,
	runtime: EndpointsTransitionRuntime
): Result | void {
	let address = `${event.host}:${event.port}`
	let prev = ctx.pinned.get(event.nodeId)
	ctx.pinned.set(event.nodeId, {
		nodeId: event.nodeId,
		host: event.host,
		port: event.port,
		address,
		location: event.location,
		loadFactor: 0,
		sslTargetNameOverride: event.sslTargetNameOverride,
		ipV4: event.ipV4,
		ipV6: event.ipV6,
		bridgePileName: '',
		services: [],
		subState: 'pinned',
		generation: event.generation,
	})
	rebuild(ctx, runtime)
	// Re-pinning the same node to a new address/generation must drop the old
	// pinned channel so the next acquire dials the new target.
	if (prev !== undefined && (prev.address !== address || prev.generation !== event.generation)) {
		return {
			effects: [
				{ type: 'endpoints.effect.close_channel', nodeId: event.nodeId, store: 'pinned' },
			],
		}
	}
}

let applyInvalidate = function applyInvalidate(
	ctx: EndpointsCtx,
	nodeId: bigint,
	runtime: EndpointsTransitionRuntime
): Result | void {
	let entry = ctx.pinned.get(nodeId)
	if (entry === undefined) return
	ctx.pinned.delete(nodeId)
	rebuild(ctx, runtime)
	// Close only the pinned channel — a discovered channel sharing this nodeId
	// stays live (invalidating a pin must not abort healthy discovered streams).
	return { effects: [{ type: 'endpoints.effect.close_channel', nodeId, store: 'pinned' }] }
}

// ── Transition ──────────────────────────────────────────────────────────────
export let endpointsTransition = function endpointsTransition(
	ctx: EndpointsCtx,
	event: EndpointsEvent,
	runtime: EndpointsTransitionRuntime
): Result | void {
	let state = runtime.state

	// Global hard destroy from any non-terminal state.
	if (state !== 'closed' && event.type === 'endpoints.destroy') {
		return terminate(ctx, event.reason ?? new Error('Endpoints destroyed'), runtime)
	}

	switch (state) {
		case 'idle':
			switch (event.type) {
				case 'endpoints.discovery.start':
					ctx.roundInFlight = true
					return {
						state: 'discovering',
						effects: [{ type: 'endpoints.effect.run_discovery_round' }],
					}
				case 'endpoints.pin':
					return applyPin(ctx, event, runtime)
				case 'endpoints.invalidate':
					return applyInvalidate(ctx, event.nodeId, runtime)
				case 'endpoints.close':
					return terminate(ctx, new Error('Endpoints closed'), runtime)
				default:
					return ignored()
			}

		case 'discovering':
			switch (event.type) {
				case 'endpoints.discovery.round_succeeded': {
					if (event.endpoints.length === 0) return rejectEmptyRound(ctx, runtime)
					let firstReady = !ctx.hasEverDiscovered
					ctx.hasEverDiscovered = true
					let effects = applyRound(
						ctx,
						event.endpoints,
						event.selfLocation,
						event.pileStates,
						runtime
					)
					effects.push({
						type: 'endpoints.effect.timer.schedule',
						which: 'discovery_interval',
					})
					effects.push({ type: 'endpoints.effect.timer.schedule', which: 'idle_sweep' })
					if (firstReady) runtime.emit({ type: 'endpoints.ready' })
					return { state: healthState(ctx), effects }
				}
				case 'endpoints.discovery.round_failed': {
					ctx.attempts += 1
					ctx.lastError = event.error
					ctx.roundInFlight = false
					runtime.emit({
						type: 'endpoints.discovery_failed',
						error: event.error,
						attempt: ctx.attempts,
						retryable: event.retryable,
					})
					if (!event.retryable) {
						return terminate(ctx, event.error, runtime, event.error)
					}
					return {
						effects: [
							{ type: 'endpoints.effect.timer.schedule', which: 'discovery_backoff' },
						],
					}
				}
				case 'endpoints.timer.discovery_backoff':
					ctx.roundInFlight = true
					return { effects: [{ type: 'endpoints.effect.run_discovery_round' }] }
				case 'endpoints.pin':
					return applyPin(ctx, event, runtime)
				case 'endpoints.invalidate':
					return applyInvalidate(ctx, event.nodeId, runtime)
				case 'endpoints.close':
					return toClosing(ctx, runtime)
				default:
					return ignored()
			}

		case 'ready':
		case 'degraded':
			switch (event.type) {
				case 'endpoints.discovery.round_succeeded': {
					// Same guard as in `discovering`: applying an empty round here
					// would retire every node and black-hole balanced RPCs until the
					// next interval while the state still reads 'ready'.
					if (event.endpoints.length === 0) return rejectEmptyRound(ctx, runtime)
					let effects = applyRound(
						ctx,
						event.endpoints,
						event.selfLocation,
						event.pileStates,
						runtime
					)
					effects.push({
						type: 'endpoints.effect.timer.schedule',
						which: 'discovery_interval',
					})
					return { state: healthState(ctx), effects }
				}
				case 'endpoints.discovery.round_failed':
					// Background failure is never terminal — keep serving the last
					// snapshot; the interval/backoff retries.
					ctx.attempts += 1
					ctx.lastError = event.error
					ctx.roundInFlight = false
					runtime.emit({
						type: 'endpoints.discovery_failed',
						error: event.error,
						attempt: ctx.attempts,
						retryable: event.retryable,
					})
					return {
						effects: [
							{ type: 'endpoints.effect.timer.schedule', which: 'discovery_backoff' },
						],
					}
				case 'endpoints.discovery.force':
				case 'endpoints.timer.discovery_interval':
				case 'endpoints.timer.discovery_backoff':
					if (ctx.roundInFlight) return ignored()
					ctx.roundInFlight = true
					return {
						effects: [
							{ type: 'endpoints.effect.timer.clear', which: 'discovery_backoff' },
							{ type: 'endpoints.effect.run_discovery_round' },
						],
					}
				case 'endpoints.rpc_failed': {
					let entry = ctx.byNodeId.get(event.nodeId)
					if (entry === undefined || entry.subState !== 'active') return ignored()
					entry.subState = 'pessimized'
					runtime.emit({
						type: 'endpoints.pessimized',
						nodeId: entry.nodeId,
						address: entry.address,
						location: entry.location,
					})
					rebuild(ctx, runtime)
					// Cross into degraded and force a round when too many are down.
					let next = healthState(ctx)
					if (next === 'degraded' && !ctx.roundInFlight) {
						ctx.roundInFlight = true
						return {
							state: 'degraded',
							effects: [
								{
									type: 'endpoints.effect.timer.clear',
									which: 'discovery_backoff',
								},
								{ type: 'endpoints.effect.run_discovery_round' },
							],
						}
					}
					return { state: next }
				}
				case 'endpoints.rpc_ok': {
					let entry = ctx.byNodeId.get(event.nodeId)
					if (entry === undefined || entry.subState !== 'pessimized') return ignored()
					entry.subState = 'active'
					runtime.emit({
						type: 'endpoints.unpessimized',
						nodeId: entry.nodeId,
						address: entry.address,
						location: entry.location,
					})
					rebuild(ctx, runtime)
					return { state: healthState(ctx) }
				}
				case 'endpoints.timer.idle_sweep':
					return { effects: [{ type: 'endpoints.effect.idle_sweep' }] }
				case 'endpoints.channel_closeable': {
					let entry = ctx.byNodeId.get(event.nodeId)
					if (entry === undefined || entry.subState !== 'retired') return ignored()
					ctx.byNodeId.delete(event.nodeId)
					rebuild(ctx, runtime)
					runtime.emit({
						type: 'endpoints.removed',
						nodeId: entry.nodeId,
						address: entry.address,
						location: entry.location,
						reason: 'idle',
					})
					return {
						effects: [{ type: 'endpoints.effect.close_channel', nodeId: event.nodeId }],
					}
				}
				case 'endpoints.pin':
					return applyPin(ctx, event, runtime)
				case 'endpoints.invalidate':
					return applyInvalidate(ctx, event.nodeId, runtime)
				case 'endpoints.close':
					return toClosing(ctx, runtime)
				default:
					return ignored()
			}

		case 'closing':
			switch (event.type) {
				case 'endpoints.channel_closeable': {
					let entry = ctx.byNodeId.get(event.nodeId) ?? ctx.pinned.get(event.nodeId)
					if (entry === undefined) return ignored()
					ctx.byNodeId.delete(event.nodeId)
					ctx.pinned.delete(event.nodeId)
					runtime.emit({
						type: 'endpoints.removed',
						nodeId: entry.nodeId,
						address: entry.address,
						location: entry.location,
						reason: 'pool_close',
					})
					let close: EndpointsEffect = {
						type: 'endpoints.effect.close_channel',
						nodeId: event.nodeId,
					}
					// Last channel drained → finalize, keeping this node's close effect.
					if (ctx.byNodeId.size === 0 && ctx.pinned.size === 0) {
						let term = terminate(ctx, new Error('Endpoints closed'), runtime)
						return { ...term, effects: [close, ...(term.effects ?? [])] }
					}
					return { effects: [close] }
				}
				case 'endpoints.timer.close_deadline':
					return terminate(ctx, new Error('Endpoints closed'), runtime)
				case 'endpoints.discovery.round_succeeded':
				case 'endpoints.discovery.round_failed':
					ctx.roundInFlight = false
					return ignored()
				default:
					return ignored()
			}

		case 'closed':
			return ignored()

		/* v8 ignore start -- EndpointsState is exhaustive; default unreachable */
		default:
			return ignored()
		/* v8 ignore stop */
	}
}
