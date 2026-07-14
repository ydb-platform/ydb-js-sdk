// The effectful half of the endpoints engine: the EndpointPool facade + the
// createEndpointsRuntime wiring. Owns all I/O — the discovery call, gRPC
// channels, timers, and the clock — while the pure FSM (endpoints-state.ts)
// owns the lifecycle and health decisions.
//
// RCU two-plane: the FSM emits an immutable RoutingSnapshot; #consume swaps
// #snapshot by reference; the synchronous acquire()/acquireNode() read that
// reference, select (pure), and materialize a channel — never dispatching on
// the hot path except a cheap fire-and-forget RPC-outcome report.

import { channel as dc, tracingChannel } from 'node:diagnostics_channel'

import { create } from '@bufbuild/protobuf'
import { connectivityState } from '@grpc/grpc-js'
import { abortable, linkSignals } from '@ydbjs/abortable'
import { PileState_State } from '@ydbjs/api/bridge'
import { EndpointInfoSchema } from '@ydbjs/api/discovery'
import type { ListEndpointsResult, EndpointInfo as ProtoEndpointInfo } from '@ydbjs/api/discovery'
import { loggers } from '@ydbjs/debug'
import { isRetryableError } from '@ydbjs/retry'
import { type MachineRuntime, createMachineRuntime } from '@ydbjs/fsm'
import type { ChannelCredentials, ChannelOptions } from 'nice-grpc'

import { type Connection, GrpcConnection } from '../conn.js'
import type { DriverIdentity } from '../driver-identity.js'
import { EndpointsUnavailableError } from '../errors.js'
import type { DriverHooks, EndpointInfo } from '../hooks.js'
import { safeHook } from '../hooks.js'
import {
	type DiscoveredEndpoint,
	type EndpointsCtx,
	type EndpointsEffect,
	type EndpointsEvent,
	type EndpointsOutput,
	type EndpointsState,
	type PileState,
	type PileStatus,
	computeRoundDiff,
	createEndpointsCtx,
	endpointsTransition,
} from './endpoints-state.js'
import {
	EMPTY_SNAPSHOT,
	type EndpointRef,
	type RoutingSnapshot,
	selectEndpoint,
} from './snapshot.js'

let dbg = loggers.driver.extend('endpoints')

let discoveryCh = tracingChannel<{ driver: DriverIdentity }>('tracing:ydb:driver.discovery')

// A discovery round's domain result. The real Driver wiring passes a closure
// that maps the proto ListEndpointsResult via `mapDiscoveryResult`; tests pass
// this shape directly. Keeping the seam DTO-shaped is what makes the module
// Driver-independent.
export type DiscoveryResult = {
	endpoints: DiscoveredEndpoint[]
	selfLocation: string
	pileStates: PileState[]
}

// The single injectable discovery dependency (idempotent, one round per call —
// retry/backoff is the FSM's job, not this seam's).
export type ListEndpoints = (signal: AbortSignal) => Promise<DiscoveryResult>

// The injectable channel seam (default = GrpcConnection). This is what makes the
// pool fully testable with drivable fake connections and retires the old
// POOL_*_FOR_TESTING symbols.
export type ConnectionFactory = (ref: EndpointRef) => Connection

export const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000
export const DEFAULT_DISCOVERY_INTERVAL_MS = 60_000
export const DEFAULT_IDLE_INTERVAL_MS = 60_000
// Retired-connection idle grace: kept this long (absorbing flaps) before it is
// eligible to be reaped when idle and un-returned by discovery.
export const DEFAULT_RETIRED_GRACE_MS = 300_000
export const DEFAULT_CLOSE_DEADLINE_MS = 10_000
export const DEFAULT_BACKOFF_BASE_MS = 50
export const DEFAULT_BACKOFF_MAX_MS = 30_000

type RemovedReason = 'idle' | 'pool_close'

type EndpointsEnv = {
	identity: DriverIdentity
	hooks: DriverHooks | undefined
	listEndpoints: ListEndpoints
	connectionFactory: ConnectionFactory

	// I/O-owned channel state — NEVER touched by the transition.
	channels: Map<bigint, Connection>
	retiredChannels: Map<bigint, Connection>
	pinnedChannels: Map<bigint, Connection>
	banStart: Map<bigint, number>
	retiredAt: Map<bigint, number>
	// When a retired channel was first seen in TRANSIENT_FAILURE — used to require
	// a SUSTAINED failure (not one blip) before reaping it.
	transientSince: Map<bigint, number>
	// Per-node in-flight RPC count, maintained by BalancedChannel around each call.
	// Lets graceful close finalize as soon as a channel's streams have drained.
	inflight: Map<bigint, number>
	// While closing: the nodeIds whose channels are still busy and must drain
	// before finalize. Undefined outside the closing drain.
	draining: Set<bigint> | undefined

	discoveryTimeoutMs: number
	discoveryIntervalMs: number
	idleIntervalMs: number
	retiredGraceMs: number
	closeDeadlineMs: number
	backoffBaseMs: number
	backoffMaxMs: number

	ac: AbortController
	readyDeferred: PromiseWithResolvers<void>
	closedDeferred: PromiseWithResolvers<void>
	isFinalized: boolean
	timers: Map<string, ReturnType<typeof setTimeout>>

	roundStart: number
	initAt: number
	readyAt: number | undefined
}

type FullCtx = EndpointsCtx & EndpointsEnv

// ── Timers (equal-jitter backoff, mirrors reader-runtime.ts) ────────────────

let backoffDelay = function backoffDelay(env: EndpointsEnv, attempts: number): number {
	let capped = Math.min(env.backoffBaseMs * 2 ** attempts, env.backoffMaxMs)
	return Math.round(capped / 2 + Math.random() * (capped / 2))
}

let clearTimerByKey = function clearTimerByKey(env: EndpointsEnv, key: string): void {
	let handle = env.timers.get(key)
	if (handle !== undefined) {
		clearTimeout(handle)
		env.timers.delete(key)
	}
}

// Physically close a materialized channel. `store: 'pinned'` closes only the pin
// (leaving a discovered channel that shares the nodeId intact); otherwise the
// channel is dropped from whichever store holds it. No diagnostics here — the FSM
// emits the `removed` output and the facade republishes it.
let dropChannel = function dropChannel(
	env: EndpointsEnv,
	nodeId: bigint,
	store: 'any' | 'pinned' = 'any'
): void {
	if (store === 'pinned') {
		let pinned = env.pinnedChannels.get(nodeId)
		env.pinnedChannels.delete(nodeId)
		if (pinned !== undefined) {
			dbg.log('close pinned channel to node %d', nodeId)
			pinned.close()
		}
		return
	}

	let conn =
		env.channels.get(nodeId) ??
		env.retiredChannels.get(nodeId) ??
		env.pinnedChannels.get(nodeId)
	env.channels.delete(nodeId)
	env.retiredChannels.delete(nodeId)
	env.pinnedChannels.delete(nodeId)
	env.banStart.delete(nodeId)
	env.retiredAt.delete(nodeId)
	env.transientSince.delete(nodeId)
	env.inflight.delete(nodeId)
	env.draining?.delete(nodeId)
	if (conn !== undefined) {
		dbg.log('close channel to node %d', nodeId)
		conn.close()
	}
}

// Idempotent teardown of all I/O: clear timers, drop every channel, abort the
// pool signal. Called by the `finalize` effect on a clean close and by #consume's
// finally as a fault backstop — one owner so the two paths can't drift.
let finalizeEnv = function finalizeEnv(env: EndpointsEnv): void {
	if (env.isFinalized) return
	env.isFinalized = true
	env.draining = undefined
	for (let handle of env.timers.values()) clearTimeout(handle)
	env.timers.clear()
	for (let nodeId of [
		...env.channels.keys(),
		...env.retiredChannels.keys(),
		...env.pinnedChannels.keys(),
	]) {
		dropChannel(env, nodeId)
	}
	if (!env.ac.signal.aborted) env.ac.abort(new Error('Endpoints finalized'))
}

// Publish the round-derived connection diagnostics + discovery.completed. Called
// INSIDE the discovery tracePromise (before the round is dispatched, so it runs
// against the pre-round registry) so @ydbjs/telemetry attaches these to the
// discovery span — the async #consume loop has no active span. Uses the same
// `computeRoundDiff` rule the FSM's applyRound uses, so the two can't drift.
let publishRoundDiagnostics = function publishRoundDiagnostics(
	ctx: FullCtx,
	result: DiscoveryResult
): void {
	let { added, retired } = computeRoundDiff(ctx.byNodeId, result.endpoints)

	for (let a of added) {
		dc('ydb:driver.connection.added').publish({
			driver: ctx.identity,
			nodeId: a.nodeId,
			address: a.address,
			location: a.location,
		})
	}
	for (let r of retired) {
		dc('ydb:driver.connection.retired').publish({
			driver: ctx.identity,
			nodeId: r.nodeId,
			address: r.address,
			location: r.location,
			reason: r.reason,
		})
	}

	dc('ydb:driver.discovery.completed').publish({
		driver: ctx.identity,
		addedCount: added.length,
		removedCount: retired.length,
		totalCount: result.endpoints.length,
		duration: Date.now() - ctx.roundStart,
	})
}

// ── Effect handlers ─────────────────────────────────────────────────────────

let effects = {
	// Discovery is unary-per-round (not a stream) — a timer/effect loop, not
	// ingest. tracePromise preserves the tracing:ydb:driver.discovery contract.
	// The round-derived diagnostics (connection.added/retired + discovery.completed)
	// are published INSIDE the tracePromise callback so @ydbjs/telemetry attaches
	// them to the discovery span — the async #consume loop has no active span, so
	// publishing them there would silently drop them from traces.
	'endpoints.effect.run_discovery_round': (ctx: FullCtx, _effect, runtime) => {
		ctx.roundStart = Date.now()
		// Bound each round independently: a single hung listEndpoints must not
		// wedge the single-flight discovery forever (a timeout is retryable). A
		// clearable timer (not AbortSignal.timeout, whose timer can't be cancelled)
		// so a fast round doesn't leave a live timeout pending until it fires.
		let timeoutAc = new AbortController()
		let timer = setTimeout(
			() => timeoutAc.abort(new Error('discovery round timed out')),
			ctx.discoveryTimeoutMs
		)
		timer.unref?.()
		// linkSignals (not AbortSignal.any) so the listeners are removed on dispose
		// — a churn of short-lived pools must not accumulate signal listeners.
		let link = linkSignals(ctx.ac.signal, timeoutAc.signal)
		void (async () => {
			try {
				let result = await discoveryCh.tracePromise(
					async () => {
						let r = await ctx.listEndpoints(link.signal)
						if (!ctx.ac.signal.aborted) publishRoundDiagnostics(ctx, r)
						return r
					},
					{ driver: ctx.identity }
				)
				if (ctx.ac.signal.aborted) return
				runtime.dispatch({
					type: 'endpoints.discovery.round_succeeded',
					endpoints: result.endpoints,
					selfLocation: result.selfLocation,
					pileStates: result.pileStates,
				})
			} catch (error) {
				if (ctx.ac.signal.aborted) return
				// A per-round timeout (not the pool abort) is retryable — keep the
				// interval/backoff cadence rather than treating it as terminal.
				let timedOut = timeoutAc.signal.aborted
				runtime.dispatch({
					type: 'endpoints.discovery.round_failed',
					error,
					retryable: timedOut || isRetryableError(error, true),
				})
			} finally {
				clearTimeout(timer)
				link[Symbol.dispose]()
			}
		})()
	},

	'endpoints.effect.timer.schedule': (ctx: FullCtx, effect, runtime) => {
		let key = effect.which
		clearTimerByKey(ctx, key)

		let repeating = effect.which === 'discovery_interval' || effect.which === 'idle_sweep'
		let delay =
			effect.which === 'discovery_interval'
				? ctx.discoveryIntervalMs
				: effect.which === 'idle_sweep'
					? ctx.idleIntervalMs
					: effect.which === 'discovery_backoff'
						? backoffDelay(ctx, ctx.attempts)
						: ctx.closeDeadlineMs

		let event: EndpointsEvent =
			effect.which === 'discovery_interval'
				? { type: 'endpoints.timer.discovery_interval' }
				: effect.which === 'idle_sweep'
					? { type: 'endpoints.timer.idle_sweep' }
					: effect.which === 'discovery_backoff'
						? { type: 'endpoints.timer.discovery_backoff' }
						: { type: 'endpoints.timer.close_deadline' }

		let handle = repeating
			? setInterval(() => runtime.dispatch(event), delay)
			: setTimeout(() => {
					ctx.timers.delete(key)
					runtime.dispatch(event)
				}, delay)
		handle.unref?.()
		ctx.timers.set(key, handle)
	},

	'endpoints.effect.timer.clear': (ctx: FullCtx, effect) => {
		clearTimerByKey(ctx, effect.which)
	},

	// Retire-to-drain: keep the channel open, move it to the drain-watch set. If
	// the node was never dialed there is nothing to drain — tell the FSM it is
	// closeable now so the registry entry is reaped instead of leaking forever
	// (idle_sweep only scans materialized retired channels).
	'endpoints.effect.retire_channel': (ctx: FullCtx, effect, runtime) => {
		let conn = ctx.channels.get(effect.nodeId)
		if (conn === undefined) {
			runtime.dispatch({ type: 'endpoints.channel_closeable', nodeId: effect.nodeId })
			return
		}
		ctx.channels.delete(effect.nodeId)
		ctx.retiredChannels.set(effect.nodeId, conn)
		ctx.retiredAt.set(effect.nodeId, Date.now())
	},

	'endpoints.effect.close_channel': (ctx: FullCtx, effect) => {
		dropChannel(ctx, effect.nodeId, effect.store ?? 'any')
	},

	// Graceful close: an idle channel is closeable now; a busy one is registered
	// so it becomes closeable as soon as its in-flight streams finish (`callEnded`
	// dispatches `channel_closeable`). Dropping the last channel finalizes the
	// FSM; `close_deadline` is the hard cap. This is what keeps `await using
	// driver` from always waiting the full deadline.
	'endpoints.effect.begin_close_drain': (ctx: FullCtx, _effect, runtime) => {
		ctx.draining = new Set()
		let watch = (nodeId: bigint, hasChannel: boolean) => {
			let busy = hasChannel && (ctx.inflight.get(nodeId) ?? 0) > 0
			if (busy) ctx.draining!.add(nodeId)
			else runtime.dispatch({ type: 'endpoints.channel_closeable', nodeId })
		}
		for (let nodeId of ctx.byNodeId.keys()) {
			watch(nodeId, ctx.channels.has(nodeId) || ctx.retiredChannels.has(nodeId))
		}
		for (let nodeId of ctx.pinned.keys()) {
			watch(nodeId, ctx.pinnedChannels.has(nodeId))
		}
	},

	// Reap retired channels that are genuinely gone. A working (READY / idle-but-
	// reconnectable) channel is KEPT so a returning node reuses it — no churn.
	// SHUTDOWN is closed at once; a TRANSIENT_FAILURE must be SUSTAINED past the
	// grace window (one blip is absorbed), same as any other non-READY idle state.
	'endpoints.effect.idle_sweep': (ctx: FullCtx, _effect, runtime) => {
		let now = Date.now()
		for (let [nodeId, conn] of ctx.retiredChannels) {
			let state = conn.channel.getConnectivityState(false)
			if (state === connectivityState.READY) {
				ctx.transientSince.delete(nodeId)
				continue
			}
			if (state === connectivityState.SHUTDOWN) {
				runtime.dispatch({ type: 'endpoints.channel_closeable', nodeId })
				continue
			}
			if (state === connectivityState.TRANSIENT_FAILURE && !ctx.transientSince.has(nodeId)) {
				ctx.transientSince.set(nodeId, now)
			}
			// Non-READY (incl. sustained TRANSIENT_FAILURE) at/past the grace window
			// (>= so a zero grace reaps a non-READY channel on the first sweep).
			if (now - (ctx.retiredAt.get(nodeId) ?? now) >= ctx.retiredGraceMs) {
				runtime.dispatch({ type: 'endpoints.channel_closeable', nodeId })
			}
		}
	},

	// closedDeferred is resolved by #consume when it publishes the `closed` output,
	// so `await close()` returns only after ydb:driver.closed is published (and as
	// a fault backstop in #consume's finally) — not here.
	'endpoints.effect.finalize': (ctx: FullCtx) => {
		finalizeEnv(ctx)
	},
} satisfies {
	[K in EndpointsEffect['type']]: (
		ctx: FullCtx,
		effect: Extract<EndpointsEffect, { type: K }>,
		runtime: { emit(o: EndpointsOutput): void; dispatch(e: EndpointsEvent): void }
	) => void
}

// ── Facade ──────────────────────────────────────────────────────────────────

export type EndpointsRuntime = {
	machine: MachineRuntime<EndpointsState, EndpointsCtx, EndpointsEvent, EndpointsOutput>
	pool: EndpointPool
}

export class EndpointPool implements Disposable, AsyncDisposable {
	#machine: MachineRuntime<EndpointsState, EndpointsCtx, EndpointsEvent, EndpointsOutput>
	#env: EndpointsEnv
	// RCU read plane — swapped by reference in #consume, read (never mutated) by acquire.
	#snapshot: RoutingSnapshot = EMPTY_SNAPSHOT

	constructor(
		machine: MachineRuntime<EndpointsState, EndpointsCtx, EndpointsEvent, EndpointsOutput>
	) {
		this.#machine = machine
		// The machine merges env into ctx once (Object.assign(ctx, env)); effects
		// mutate THAT object. Read the same merged object here so scalar writes made
		// inside effects (isFinalized, draining, roundStart, readyAt) are visible —
		// a separate `env` reference would only share the Map/object fields, not the
		// reassigned scalars.
		this.#env = machine.ctx as unknown as EndpointsEnv
		void this.#consume().catch((error) => dbg.log('consume loop ended: %O', error))
	}

	get snapshot(): RoutingSnapshot {
		return this.#snapshot
	}

	// ── SYNCHRONOUS hot path — one Map.get or one random index + lazy materialize ──
	acquire(preferNodeId?: bigint): Connection {
		if (this.#env.isFinalized) throw new EndpointsUnavailableError('Endpoints closed')
		let ref = selectEndpoint(this.#snapshot, preferNodeId !== undefined ? { preferNodeId } : {})
		if (ref === undefined) throw new EndpointsUnavailableError()
		return this.#materialize(ref)
	}

	// Direct-IO: exact node. `hard` never substitutes (throws on miss) — for a
	// server-named node_id outside ListEndpoints.
	acquireNode(nodeId: bigint, opts: { hard?: boolean } = {}): Connection {
		if (this.#env.isFinalized) throw new EndpointsUnavailableError('Endpoints closed')
		let ref = selectEndpoint(this.#snapshot, { preferNodeId: nodeId, hard: opts.hard ?? false })
		if (ref === undefined) throw new EndpointsUnavailableError(`No endpoint for node ${nodeId}`)
		return this.#materialize(ref)
	}

	// Move a node out of active rotation after a transport failure. Fire-and-forget:
	// enqueue-only, handled async off the hot path. Callers penalize only on
	// pessimizable (non-cancel transport) errors.
	penalize(nodeId: bigint): void {
		this.#machine.dispatch({ type: 'endpoints.rpc_failed', nodeId })
	}

	// Restore a node to active rotation after a successful RPC (no-op unless it is
	// currently pessimized). Fire-and-forget, same as penalize().
	recover(nodeId: bigint): void {
		this.#machine.dispatch({ type: 'endpoints.rpc_ok', nodeId })
	}

	// Call-lifecycle bookkeeping used by BalancedChannel to keep a per-node
	// in-flight count. Graceful close consults it to finalize as soon as a
	// channel's streams have drained instead of waiting the full close deadline.
	callStarted(nodeId: bigint): void {
		this.#env.inflight.set(nodeId, (this.#env.inflight.get(nodeId) ?? 0) + 1)
	}

	callEnded(nodeId: bigint): void {
		let n = (this.#env.inflight.get(nodeId) ?? 0) - 1
		if (n > 0) {
			this.#env.inflight.set(nodeId, n)
			return
		}
		this.#env.inflight.delete(nodeId)
		// If this channel was the last thing a close() was waiting to drain, tell
		// the FSM it is now closeable.
		if (this.#env.draining?.has(nodeId)) {
			this.#env.draining.delete(nodeId)
			this.#machine.dispatch({ type: 'endpoints.channel_closeable', nodeId })
		}
	}

	pin(
		nodeId: bigint,
		host: string,
		port: number,
		opts: {
			location?: string | undefined
			sslTargetNameOverride?: string | undefined
			ipV4?: string[] | undefined
			ipV6?: string[] | undefined
			generation?: number | undefined
		} = {}
	): void {
		this.#machine.dispatch({
			type: 'endpoints.pin',
			nodeId,
			host,
			port,
			location: opts.location ?? '',
			sslTargetNameOverride: opts.sslTargetNameOverride ?? '',
			ipV4: opts.ipV4 ?? [],
			ipV6: opts.ipV6 ?? [],
			generation: opts.generation ?? 0,
		})
	}

	invalidate(nodeId: bigint): void {
		this.#machine.dispatch({ type: 'endpoints.invalidate', nodeId })
	}

	forceRediscovery(): void {
		this.#machine.dispatch({ type: 'endpoints.discovery.force' })
	}

	async ready(signal?: AbortSignal): Promise<void> {
		// readyDeferred is the authoritative latch: #consume resolves it on
		// `ready` and rejects it with the real cause on `failed`/`closed`. We do
		// NOT link the pool's own ac.signal here — its abort reason ('Endpoints
		// finalized') would otherwise race ahead of the true discovery error.
		let promise = this.#env.readyDeferred.promise
		await (signal !== undefined ? abortable(signal, promise) : promise)
	}

	async close(): Promise<void> {
		this.#machine.dispatch({ type: 'endpoints.close' })
		await this.#env.closedDeferred.promise
	}

	[Symbol.dispose](): void {
		this.#machine.dispatch({ type: 'endpoints.destroy' })
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close()
	}

	#materialize(ref: EndpointRef): Connection {
		let nodeId = ref.nodeId
		let existing =
			this.#env.channels.get(nodeId) ??
			this.#env.retiredChannels.get(nodeId) ??
			this.#env.pinnedChannels.get(nodeId)
		if (existing !== undefined) return existing
		let conn = this.#env.connectionFactory(ref)
		if (ref.state === 'pinned') {
			this.#env.pinnedChannels.set(nodeId, conn)
		} else if (ref.state === 'retired') {
			// A channel first dialed after the node was retired must land in the
			// retired store so idle_sweep governs it — otherwise it escapes reaping.
			this.#env.retiredChannels.set(nodeId, conn)
			this.#env.retiredAt.set(nodeId, Date.now())
		} else {
			this.#env.channels.set(nodeId, conn)
		}
		return conn
	}

	// RCU swap + diagnostics republish — consumes the machine's output stream
	// (the reader.ts pattern), NOT ingest. The round-derived events
	// (connection.added/retired + discovery.completed) are published by the
	// discovery effect inside the tracing span, not here — see
	// publishRoundDiagnostics. The try/finally is a backstop: if the machine
	// faults (a transition/effect throws, the iterator rethrows), close()/ready()
	// awaiters are still released and channels/timers are still torn down.
	async #consume(): Promise<void> {
		let env = this.#env
		try {
			await this.#drain()
		} catch (error) {
			dbg.log('endpoints machine faulted: %O', error)
			env.readyDeferred.reject(error)
		} finally {
			finalizeEnv(env)
			// No-ops if already settled; guarantees no awaiter hangs on a fault.
			env.readyDeferred.reject(new Error('Endpoints closed'))
			env.closedDeferred.resolve()
		}
	}

	async #drain(): Promise<void> {
		let env = this.#env
		for await (let out of this.#machine) {
			switch (out.type) {
				case 'endpoints.snapshot':
					this.#snapshot = out.snapshot
					break
				case 'endpoints.added':
				case 'endpoints.retired':
					// Published within the discovery span by publishRoundDiagnostics.
					break
				case 'endpoints.removed':
					dc('ydb:driver.connection.removed').publish({
						driver: env.identity,
						nodeId: out.nodeId,
						address: out.address,
						location: out.location,
						reason: out.reason satisfies RemovedReason,
					})
					break
				case 'endpoints.pessimized':
					env.banStart.set(out.nodeId, Date.now())
					safeHook('onPessimize', () =>
						env.hooks?.onPessimize?.({
							endpoint: {
								nodeId: out.nodeId,
								address: out.address,
								location: out.location,
							},
						})
					)
					dc('ydb:driver.connection.pessimized').publish({
						driver: env.identity,
						nodeId: out.nodeId,
						address: out.address,
						location: out.location,
					})
					break
				case 'endpoints.unpessimized': {
					let duration = Date.now() - (env.banStart.get(out.nodeId) ?? Date.now())
					env.banStart.delete(out.nodeId)
					safeHook('onUnpessimize', () =>
						env.hooks?.onUnpessimize?.({
							endpoint: {
								nodeId: out.nodeId,
								address: out.address,
								location: out.location,
							},
						})
					)
					dc('ydb:driver.connection.unpessimized').publish({
						driver: env.identity,
						nodeId: out.nodeId,
						address: out.address,
						location: out.location,
						duration,
					})
					break
				}
				case 'endpoints.discovery_completed': {
					// ydb:driver.discovery.completed is published within the discovery
					// span by publishRoundDiagnostics; here we only fire the hook.
					let duration = Date.now() - env.roundStart
					safeHook('onDiscovery', () =>
						env.hooks?.onDiscovery?.({
							added: out.added.map(toEndpointInfo),
							removed: out.removed.map(toEndpointInfo),
							duration,
							endpoints: this.#snapshotEndpoints(),
						})
					)
					break
				}
				case 'endpoints.discovery_failed':
					safeHook('onDiscoveryError', () =>
						env.hooks?.onDiscoveryError?.({
							error: out.error,
							attempt: out.attempt,
							duration: Date.now() - env.roundStart,
						})
					)
					break
				case 'endpoints.ready':
					env.readyAt = Date.now()
					env.readyDeferred.resolve()
					dc('ydb:driver.ready').publish({
						driver: env.identity,
						duration: env.readyAt - env.initAt,
					})
					break
				case 'endpoints.failed':
					env.readyDeferred.reject(out.error)
					dc('ydb:driver.failed').publish({
						driver: env.identity,
						duration: Date.now() - env.initAt,
						error: out.error,
					})
					break
				case 'endpoints.closed':
					env.readyDeferred.reject(new Error('Endpoints closed'))
					dc('ydb:driver.closed').publish({
						driver: env.identity,
						uptime: env.readyAt !== undefined ? Date.now() - env.readyAt : 0,
					})
					// Resolve AFTER the publish so `await close()` observes it.
					env.closedDeferred.resolve()
					break
			}
		}
	}

	#snapshotEndpoints(): EndpointInfo[] {
		return Array.from(this.#snapshot.byNodeId.values(), toEndpointInfo)
	}
}

let toEndpointInfo = function toEndpointInfo(e: {
	nodeId: bigint
	address: string
	location: string
}): EndpointInfo {
	return Object.freeze<EndpointInfo>({
		nodeId: e.nodeId,
		address: e.address,
		location: e.location,
	})
}

// ── Wiring ──────────────────────────────────────────────────────────────────

export type EndpointsRuntimeConfig = {
	identity: DriverIdentity
	listEndpoints: ListEndpoints
	channelCredentials: ChannelCredentials
	channelOptions?: ChannelOptions | undefined
	connectionFactory?: ConnectionFactory | undefined
	hooks?: DriverHooks | undefined
	localityEnabled?: boolean | undefined
	degradedThreshold?: number | undefined
	discoveryTimeoutMs?: number | undefined
	discoveryIntervalMs?: number | undefined
	idleIntervalMs?: number | undefined
	retiredGraceMs?: number | undefined
	closeDeadlineMs?: number | undefined
}

export let createEndpointsRuntime = function createEndpointsRuntime(
	config: EndpointsRuntimeConfig
): EndpointsRuntime {
	let defaultFactory: ConnectionFactory = (ref) =>
		new GrpcConnection(
			defaultProtoEndpoint(ref),
			config.channelCredentials,
			config.channelOptions
		)

	let env: EndpointsEnv = {
		identity: config.identity,
		hooks: config.hooks,
		listEndpoints: config.listEndpoints,
		connectionFactory: config.connectionFactory ?? defaultFactory,
		channels: new Map(),
		retiredChannels: new Map(),
		pinnedChannels: new Map(),
		banStart: new Map(),
		retiredAt: new Map(),
		transientSince: new Map(),
		inflight: new Map(),
		draining: undefined,
		discoveryTimeoutMs: config.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
		discoveryIntervalMs: config.discoveryIntervalMs ?? DEFAULT_DISCOVERY_INTERVAL_MS,
		idleIntervalMs: config.idleIntervalMs ?? DEFAULT_IDLE_INTERVAL_MS,
		retiredGraceMs: config.retiredGraceMs ?? DEFAULT_RETIRED_GRACE_MS,
		closeDeadlineMs: config.closeDeadlineMs ?? DEFAULT_CLOSE_DEADLINE_MS,
		backoffBaseMs: DEFAULT_BACKOFF_BASE_MS,
		backoffMaxMs: DEFAULT_BACKOFF_MAX_MS,
		ac: new AbortController(),
		readyDeferred: Promise.withResolvers<void>(),
		closedDeferred: Promise.withResolvers<void>(),
		isFinalized: false,
		timers: new Map(),
		roundStart: 0,
		initAt: Date.now(),
		readyAt: undefined,
	}
	// Silence unobserved-rejection noise when nobody awaits ready().
	env.readyDeferred.promise.catch(() => {})

	let ctx = createEndpointsCtx({
		localityEnabled: config.localityEnabled,
		degradedThreshold: config.degradedThreshold,
	})

	let machine = createMachineRuntime<
		EndpointsState,
		EndpointsCtx,
		EndpointsEnv,
		EndpointsEvent,
		EndpointsEffect,
		EndpointsOutput
	>({
		initialState: 'idle',
		ctx,
		env,
		transition: endpointsTransition,
		effects,
	})

	let pool = new EndpointPool(machine)

	// No ingest — discovery is unary-per-round. Kick the initial round.
	machine.dispatch({ type: 'endpoints.discovery.start' })

	return { machine, pool }
}

let defaultProtoEndpoint = function defaultProtoEndpoint(ref: EndpointRef): ProtoEndpointInfo {
	return create(EndpointInfoSchema, {
		address: ref.host,
		port: ref.port,
		nodeId: Number(ref.nodeId),
		location: ref.location,
		sslTargetNameOverride: ref.sslTargetNameOverride,
	})
}

// Map a raw proto ListEndpointsResult to the domain DiscoveryResult. Used by the
// future Driver wiring. pile_states is empty on non-bridge clusters ⇒ identity.
export let mapDiscoveryResult = function mapDiscoveryResult(
	result: ListEndpointsResult
): DiscoveryResult {
	let endpoints: DiscoveredEndpoint[] = result.endpoints.map((ep) => ({
		nodeId: BigInt(ep.nodeId),
		host: ep.address,
		port: ep.port,
		location: ep.location,
		loadFactor: ep.loadFactor,
		sslTargetNameOverride: ep.sslTargetNameOverride,
		ipV4: ep.ipV4,
		ipV6: ep.ipV6,
		bridgePileName: ep.bridgePileName,
		services: ep.service,
	}))
	let pileStates: PileState[] = result.pileStates.map((p) => ({
		pileName: p.pileName,
		status: mapPileStatus(p.state),
	}))
	return { endpoints, selfLocation: result.selfLocation, pileStates }
}

let mapPileStatus = function mapPileStatus(state: PileState_State): PileStatus {
	switch (state) {
		case PileState_State.PRIMARY:
			return 'PRIMARY'
		case PileState_State.PROMOTED:
			return 'PROMOTED'
		case PileState_State.SYNCHRONIZED:
			return 'SYNCHRONIZED'
		case PileState_State.NOT_SYNCHRONIZED:
			return 'NOT_SYNCHRONIZED'
		case PileState_State.SUSPENDED:
			return 'SUSPENDED'
		case PileState_State.DISCONNECTED:
			return 'DISCONNECTED'
		default:
			return 'UNSPECIFIED'
	}
}
