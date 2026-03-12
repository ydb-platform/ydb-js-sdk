import { abortable } from '@ydbjs/abortable'
import { CoordinationServiceDefinition } from '@ydbjs/api/coordination'
import type { Driver } from '@ydbjs/core'
import { loggers } from '@ydbjs/debug'
import { type MachineRuntime, createMachineRuntime } from '@ydbjs/fsm'
import { AsyncQueue } from '@ydbjs/fsm/queue'

import type { CoordinationSessionOptions } from './session-options.js'
import { createSemaphoreOperations } from './session-operations.js'
import { type Deferred, SessionRequestRegistry, createDeferred } from './session-registry.js'
import type { SemaphoreRuntime } from './semaphore-runtime.js'
import {
	type CoordinationSessionClient,
	type SessionStreamRequest,
	type WatchChange,
	type WatchRegistration,
	closeStream,
	openStream,
	sendPong,
	sendStop,
} from './session-stream.js'
import {
	type SessionCtx,
	type SessionEffect,
	type SessionEvent,
	type SessionOutput,
	type SessionState,
	createSessionCtx,
	sessionTransition,
} from './session-state.js'

let dbg = loggers.topic.extend('coordination').extend('session-runtime')

// ── public types ───────────────────────────────────────────────────────────────

export type SessionStatus = SessionState

export type SessionRuntime = SemaphoreRuntime & {
	readonly runtime: MachineRuntime<SessionState, SessionCtx, SessionEvent, SessionOutput>
	// NOTE: SessionEnv is intentionally omitted from the public runtime type —
	// consumers should not access env fields through the runtime handle.
	get sessionId(): bigint | null
	get status(): SessionStatus
	waitReady(signal?: AbortSignal): Promise<void>
	close(signal?: AbortSignal): Promise<void>
	destroy(reason?: unknown): void
}

// Runtime I/O handles passed as env to the FSM.
// Never exposed to the transition function — only accessible in effect handlers.
export type SessionEnv = {
	// Connection-level constants — set once at runtime creation, never reassigned.
	client: CoordinationSessionClient
	options: CoordinationSessionOptions
	signal: AbortSignal | undefined

	readyDeferred: Deferred<void>
	closedDeferred: Deferred<void>
	requests: SessionRequestRegistry
	signalController: AbortController
	streamAbortController: AbortController | null
	streamInput: AsyncQueue<SessionStreamRequest> | null
	streamIngest: AsyncDisposable | null
	watchesByName: Map<string, WatchRegistration>
	watchesByReqId: Map<bigint, { name: string; queue: AsyncQueue<WatchChange> }>
	timerStartTimeout: NodeJS.Timeout | null
	timerRetryBackoff: NodeJS.Timeout | null
	timerRecoveryWindow: NodeJS.Timeout | null
	isFinalized: boolean
}

// Merged context visible to effect handlers: logical flags (SessionCtx) + runtime handles (SessionEnv).
// Matches the LC & RC type the FSM framework passes to every effect handler.
type SessionFullCtx = SessionCtx & SessionEnv

// ── local helpers ──────────────────────────────────────────────────────────────

let clearTimer = function clearTimer(timer: NodeJS.Timeout | null): null {
	if (timer) {
		clearTimeout(timer)
	}

	return null
}

let createRuntimeSignal = function createRuntimeSignal(
	runtimeSignal: AbortSignal,
	externalSignal?: AbortSignal
): AbortSignal {
	if (!externalSignal) {
		return runtimeSignal
	}

	return AbortSignal.any([runtimeSignal, externalSignal])
}

// ── env factory ────────────────────────────────────────────────────────────────

export let createSessionEnv = function createSessionEnv(
	driver: Driver,
	options: CoordinationSessionOptions,
	signal?: AbortSignal
): SessionEnv {
	return {
		signal,
		client: driver.createClient(CoordinationServiceDefinition) as CoordinationSessionClient,
		options,

		readyDeferred: createDeferred<void>(),
		closedDeferred: createDeferred<void>(),
		requests: new SessionRequestRegistry(),
		signalController: new AbortController(),
		streamAbortController: null,
		streamInput: null,
		streamIngest: null,
		watchesByName: new Map(),
		watchesByReqId: new Map(),
		timerStartTimeout: null,
		timerRetryBackoff: null,
		timerRecoveryWindow: null,
		isFinalized: false,
	}
}

// ── lifecycle effects ──────────────────────────────────────────────────────────

let finalizeRuntime = function finalizeRuntime(
	ctx: SessionFullCtx,
	reason: unknown,
	kind: 'closed' | 'expired'
): void {
	if (ctx.isFinalized) {
		return
	}

	ctx.isFinalized = true

	// Abort all active semaphore watch subscriptions so their async generators
	// exit cleanly.  Clear both maps so no stale references remain.
	for (let [, registration] of ctx.watchesByName) {
		registration.signalController.abort(reason)
		registration.queue.close()
	}
	ctx.watchesByName.clear()
	ctx.watchesByReqId.clear()

	ctx.requests.destroy(reason)
	ctx.readyDeferred.reject(reason)
	ctx.closedDeferred.resolve()
	ctx.signalController.abort(reason)

	dbg.log('runtime finalized as %s: %O', kind, reason)
}

let markReady = async function markReady(ctx: SessionFullCtx, sessionId: bigint): Promise<void> {
	ctx.readyDeferred.resolve()
	dbg.log('session ready: %s', sessionId.toString())
}

let markClosed = async function markClosed(ctx: SessionFullCtx, reason: unknown): Promise<void> {
	await closeStream(ctx)
	finalizeRuntime(ctx, reason, 'closed')
}

let markExpired = async function markExpired(ctx: SessionFullCtx, reason: unknown): Promise<void> {
	await closeStream(ctx)
	finalizeRuntime(ctx, reason, 'expired')
}

// ── waitReady ──────────────────────────────────────────────────────────────────

// Block until the session reaches ready state.  Loops on transient reconnect
// rejections so callers are not interrupted by reconnects that succeed.
let waitReady = async function waitReady(ctx: SessionFullCtx, signal?: AbortSignal): Promise<void> {
	let targetSignal = createRuntimeSignal(ctx.signalController.signal, signal)

	// Loop to handle transient reconnect rejections: when the session goes into
	// reconnecting (before or after the first ready), readyDeferred is rejected
	// and a new one is installed.  Re-wait on the fresh deferred until the session
	// is truly ready or a terminal condition (signal abort, expiry) is reached.
	for (;;) {
		try {
			// oxlint-disable-next-line no-await-in-loop
			await abortable(targetSignal, ctx.readyDeferred.promise)
			return
		} catch (error) {
			// Combined signal fired — session terminated or caller cancelled.
			if (targetSignal.aborted) {
				throw error
			}
			// Transient reconnect — effect handler has replaced readyDeferred.
			// Fall through and wait on the new one.
		}
	}
}

// ── main factory ───────────────────────────────────────────────────────────────

export function createRuntime(
	driver: Driver,
	options: CoordinationSessionOptions,
	outerSignal?: AbortSignal
): SessionRuntime {
	let machineRuntime = createMachineRuntime<
		SessionState,
		SessionCtx,
		SessionEnv,
		SessionEvent,
		SessionEffect,
		SessionOutput
	>({
		initialState: 'idle',
		ctx: createSessionCtx(),
		env: createSessionEnv(driver, options, outerSignal),
		transition: sessionTransition,
		effects: {
			'session.effect.stream.open': async (ctx, _effect, runtime) => {
				await openStream(ctx, runtime)
			},
			'session.effect.stream.close': async (ctx) => {
				await closeStream(ctx)
			},
			'session.effect.stream.send_stop': (ctx) => {
				// Prevent new requests from being registered during graceful close.
				ctx.requests.close()
				sendStop(ctx)
			},
			'session.effect.stream.send_pong': (ctx, effect) => {
				sendPong(ctx, effect.opaque)
			},
			'session.effect.timer.schedule_start_timeout': (ctx, _effect, runtime) => {
				ctx.timerStartTimeout = clearTimer(ctx.timerStartTimeout)
				ctx.timerStartTimeout = setTimeout(() => {
					ctx.timerStartTimeout = null
					runtime.dispatch({ type: 'session.timer.start_timeout' })
				}, ctx.options.startTimeout ?? 3_000)
			},
			'session.effect.timer.schedule_retry_backoff': (ctx, _effect, runtime) => {
				// Reject in-flight requests so they can retry after reconnect.
				ctx.requests.reconnect()

				// Replace readyDeferred so any caller currently in waitReady() blocks
				// again rather than seeing the already-resolved promise from the
				// previous ready state.
				ctx.readyDeferred.reject(new Error('Session reconnecting'))
				ctx.readyDeferred = createDeferred<void>()

				ctx.timerRetryBackoff = clearTimer(ctx.timerRetryBackoff)
				ctx.timerRetryBackoff = setTimeout(() => {
					ctx.timerRetryBackoff = null
					runtime.dispatch({ type: 'session.timer.retry_backoff_elapsed' })
				}, ctx.options.retryBackoff ?? 30)
			},
			'session.effect.timer.schedule_recovery_window': (ctx, _effect, runtime) => {
				// Guard: only one recovery window timer may be active at a time.
				if (ctx.timerRecoveryWindow) {
					return
				}

				ctx.timerRecoveryWindow = setTimeout(() => {
					ctx.timerRecoveryWindow = null
					runtime.dispatch({ type: 'session.timer.recovery_window_expired' })
				}, ctx.options.recoveryWindow ?? 30_000)
			},
			'session.effect.timer.clear_start_timeout': (ctx) => {
				ctx.timerStartTimeout = clearTimer(ctx.timerStartTimeout)
			},
			'session.effect.timer.clear_retry_backoff': (ctx) => {
				ctx.timerRetryBackoff = clearTimer(ctx.timerRetryBackoff)
			},
			'session.effect.timer.clear_recovery_window': (ctx) => {
				ctx.timerRecoveryWindow = clearTimer(ctx.timerRecoveryWindow)
			},
			'session.effect.runtime.restore_after_reconnect': (ctx) => {
				dbg.log('restoring semaphore watches after reconnect')
				// Push a synthetic change to every active watch queue so the
				// watchSemaphore generator re-fetches the current description and
				// re-registers the server-side watch after reconnecting.
				for (let watch of ctx.watchesByName.values()) {
					watch.queue.push({ dataChanged: false, ownersChanged: false })
				}
			},
			'session.effect.runtime.emit_error': (_ctx, effect) => {
				dbg.log('session runtime error: %O', effect.error)
			},
			'session.effect.runtime.mark_ready': async (ctx, effect) => {
				await markReady(ctx, effect.sessionId)
			},
			'session.effect.runtime.mark_closed': async (ctx, effect) => {
				await markClosed(ctx, effect.reason)
			},
			'session.effect.runtime.mark_expired': async (ctx, effect) => {
				await markExpired(ctx, effect.reason)
			},
		},
	})

	// sessionCtx() always returns the current merged context (LC & RC).
	// Used by external methods that live outside the effect handler scope.
	let sessionCtx = (): SessionFullCtx => machineRuntime.ctx as unknown as SessionFullCtx

	if (outerSignal) {
		if (outerSignal.aborted) {
			machineRuntime.dispatch({ type: 'session.destroy', reason: outerSignal.reason })
		} else {
			outerSignal.addEventListener(
				'abort',
				() => {
					machineRuntime.dispatch({ type: 'session.destroy', reason: outerSignal.reason })
				},
				{ once: true }
			)
		}
	}

	machineRuntime.dispatch({ type: 'session.start' })

	// Build the semaphore operations once.  Each method closes over sessionCtx
	// so it always reads the current (potentially reconnected) context.
	let ops = createSemaphoreOperations(sessionCtx)

	return {
		runtime: machineRuntime,

		// Semaphore operations delegated to session-operations.ts.
		// Methods are plain closures — they do not use `this`, so direct
		// property assignment is safe and no .bind() is needed.
		createSemaphore: ops.createSemaphore,
		updateSemaphore: ops.updateSemaphore,
		deleteSemaphore: ops.deleteSemaphore,
		acquireSemaphore: ops.acquireSemaphore,
		describeSemaphore: ops.describeSemaphore,
		watchSemaphore: ops.watchSemaphore,

		get sessionId(): bigint | null {
			return machineRuntime.ctx.sessionId
		},
		get status(): SessionStatus {
			return machineRuntime.state
		},
		// Session-level signal — aborted on close or expiry.
		get signal(): AbortSignal {
			return sessionCtx().signalController.signal
		},
		waitReady(signal?: AbortSignal): Promise<void> {
			return waitReady(sessionCtx(), signal)
		},
		close(signal?: AbortSignal): Promise<void> {
			machineRuntime.dispatch({ type: 'session.close' })
			let ctx = sessionCtx()
			let targetSignal = createRuntimeSignal(ctx.signalController.signal, signal)
			return abortable(targetSignal, ctx.closedDeferred.promise)
		},
		destroy(reason?: unknown): void {
			machineRuntime.dispatch({ type: 'session.destroy', reason })
		},
	}
}
