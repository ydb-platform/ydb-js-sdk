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

import { buildSnapshot } from './snapshot.js'
import type { RoutingSnapshot } from './snapshot.js'

// ── Bridge / multi-pile (2-DC) ──────────────────────────────────────────────
// Forward-looking: the generated @ydbjs/api discovery proto does not carry
// pile_states / bridge_pile_name yet. The runtime maps proto → DTO and defaults
// these to empty, so a non-bridge cluster gets identity behaviour (no pile
// filter). When the proto grows the fields the adapter fills them in unchanged.
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
	// The runtime observed a retired channel become closeable (drained / broken /
	// past grace) and asks the FSM to drop it.
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
	// Physically close and drop the channel.
	| { type: 'endpoints.effect.close_channel'; nodeId: bigint }
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

export type EndpointsRuntime = TransitionRuntime<EndpointsState, EndpointsEvent, EndpointsOutput>
type Result = TransitionResult<EndpointsState, EndpointsEffect>

// ── Pure helpers ────────────────────────────────────────────────────────────

let info = function info(entry: EndpointEntry): EndpointInfoLite {
	return { nodeId: entry.nodeId, address: entry.address, location: entry.location }
}

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

let rebuild = function rebuild(ctx: EndpointsCtx, runtime: EndpointsRuntime): void {
	runtime.emit({ type: 'endpoints.snapshot', snapshot: buildSnapshot(ctx) })
}

let ignored = function ignored(): void {
	// Unhandled (state, event) pair — no-op. Kept explicit for the table.
}

// Apply a fresh discovery result to the registry. Returns the effects to run
// (retire_channel for newly-stale nodes) and emits per-node outputs. Subsumes
// pool.sync() with the retire-reappear fix.
let applyRound = function applyRound(
	ctx: EndpointsCtx,
	endpoints: DiscoveredEndpoint[],
	selfLocation: string,
	pileStates: PileState[],
	runtime: EndpointsRuntime
): EndpointsEffect[] {
	let effects: EndpointsEffect[] = []
	let added: EndpointInfoLite[] = []
	let removed: EndpointInfoLite[] = []
	let discovered = new Set<bigint>()

	for (let ep of endpoints) {
		discovered.add(ep.nodeId)
		let existing = ctx.byNodeId.get(ep.nodeId)

		if (existing === undefined) {
			let entry = entryFrom(ep, 'active', 0)
			ctx.byNodeId.set(ep.nodeId, entry)
			added.push(info(entry))
			runtime.emit({
				type: 'endpoints.added',
				nodeId: entry.nodeId,
				address: entry.address,
				location: entry.location,
			})
			continue
		}

		// Refresh surface fields (location/pile/load/dial info can change).
		existing.host = ep.host
		existing.port = ep.port
		existing.address = `${ep.host}:${ep.port}`
		existing.location = ep.location
		existing.loadFactor = ep.loadFactor
		existing.sslTargetNameOverride = ep.sslTargetNameOverride
		existing.ipV4 = ep.ipV4
		existing.ipV6 = ep.ipV6
		existing.bridgePileName = ep.bridgePileName
		existing.services = ep.services

		if (existing.subState === 'retired') {
			// RETIRE-REAPPEAR FIX: revive in place, keep the draining channel.
			// Never close+recreate (that would kill live streams — pool.ts:177-186).
			existing.subState = 'active'
		} else if (existing.subState === 'pessimized') {
			// Blanket un-ban on discovery (authoritative recovery).
			existing.subState = 'active'
			runtime.emit({
				type: 'endpoints.unpessimized',
				nodeId: existing.nodeId,
				address: existing.address,
				location: existing.location,
			})
		}
	}

	// Retire endpoints that vanished from discovery. Channel stays open to drain.
	for (let entry of ctx.byNodeId.values()) {
		if (discovered.has(entry.nodeId)) continue
		if (entry.subState === 'retired') continue

		let reason: 'stale_active' | 'stale_pessimized' =
			entry.subState === 'pessimized' ? 'stale_pessimized' : 'stale_active'
		entry.subState = 'retired'
		effects.push({ type: 'endpoints.effect.retire_channel', nodeId: entry.nodeId })
		runtime.emit({
			type: 'endpoints.retired',
			nodeId: entry.nodeId,
			address: entry.address,
			location: entry.location,
			reason,
		})
		removed.push(info(entry))
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
		removed,
		total: endpoints.length,
		selfLocation,
	})

	return effects
}

let toClosing = function toClosing(ctx: EndpointsCtx, runtime: EndpointsRuntime): Result {
	// Nothing to drain → finalize immediately.
	let hasChannels = false
	for (let entry of ctx.byNodeId.values()) {
		void entry
		hasChannels = true
		break
	}
	if (!hasChannels && ctx.pinned.size === 0) {
		return terminate(ctx, new Error('Endpoints closed'), runtime)
	}

	// Freeze routing (empty prefer/fallback but keep byNodeId for in-flight
	// node-bound streams) and arm the close deadline; the runtime drains live
	// channels until then, then force-closes on `close_deadline`.
	return {
		state: 'closing',
		effects: [
			{ type: 'endpoints.effect.timer.clear', which: 'discovery_interval' },
			{ type: 'endpoints.effect.timer.clear', which: 'discovery_backoff' },
			{ type: 'endpoints.effect.timer.schedule', which: 'close_deadline' },
		],
	}
}

let terminate = function terminate(
	ctx: EndpointsCtx,
	reason: unknown,
	runtime: EndpointsRuntime,
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
	runtime: EndpointsRuntime
): Result | void {
	ctx.pinned.set(event.nodeId, {
		nodeId: event.nodeId,
		host: event.host,
		port: event.port,
		address: `${event.host}:${event.port}`,
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
}

let applyInvalidate = function applyInvalidate(
	ctx: EndpointsCtx,
	nodeId: bigint,
	runtime: EndpointsRuntime
): Result | void {
	let entry = ctx.pinned.get(nodeId)
	if (entry === undefined) return
	ctx.pinned.delete(nodeId)
	rebuild(ctx, runtime)
	return { effects: [{ type: 'endpoints.effect.close_channel', nodeId }] }
}

// ── Transition ──────────────────────────────────────────────────────────────
export let endpointsTransition = function endpointsTransition(
	ctx: EndpointsCtx,
	event: EndpointsEvent,
	runtime: EndpointsRuntime
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
					let entry = ctx.byNodeId.get(event.nodeId)
					if (entry !== undefined) {
						ctx.byNodeId.delete(event.nodeId)
						runtime.emit({
							type: 'endpoints.removed',
							nodeId: entry.nodeId,
							address: entry.address,
							location: entry.location,
							reason: 'pool_close',
						})
					}
					if (ctx.byNodeId.size === 0 && ctx.pinned.size === 0) {
						return terminate(ctx, new Error('Endpoints closed'), runtime)
					}
					return {
						effects: [{ type: 'endpoints.effect.close_channel', nodeId: event.nodeId }],
					}
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

		default:
			return ignored()
	}
}
