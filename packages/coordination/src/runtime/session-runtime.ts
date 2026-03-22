import { abortable, linkSignals } from '@ydbjs/abortable'
import { CoordinationServiceDefinition } from '@ydbjs/api/coordination'
import type { Driver } from '@ydbjs/core'
import { loggers } from '@ydbjs/debug'

import { type Deferred, createDeferred } from './session-registry.js'
import {
	type CoordinationSessionClient,
	SessionTransport,
	type TransportOutput,
} from './session-transport.js'
import {
	type SessionCtx,
	type SessionEffect,
	type SessionEvent,
	type SessionOutput,
	type SessionState,
	createSessionCtx,
	sessionTransition,
} from './session-state.js'
import { createMachineRuntime } from '@ydbjs/fsm'

let dbg = loggers.coordination.extend('session')

export type SessionStatus = SessionState

export interface SessionRuntime {
	readonly transport: SessionTransport
	get sessionId(): bigint | null
	get status(): SessionStatus
	get signal(): AbortSignal
	close(signal?: AbortSignal): Promise<void>
	destroy(reason?: unknown): void
}

// Runtime I/O handles passed as the env (RC) to the FSM.
// The transition function never sees these — only effect handlers do.
type SessionEnv = {
	path: string
	description: string
	startTimeout: number
	retryBackoff: number
	recoveryWindow: number

	ac: AbortController
	transport: SessionTransport
	isFinalized: boolean
	closedDeferred: Deferred<void>

	timerStartTimeout: ReturnType<typeof setTimeout> | null
	timerRetryBackoff: ReturnType<typeof setTimeout> | null
	timerRecoveryWindow: ReturnType<typeof setTimeout> | null
}

type FullCtx = SessionCtx & SessionEnv

let clearTimer = function clearTimer(timer: ReturnType<typeof setTimeout> | null): null {
	if (timer) {
		clearTimeout(timer)
	}

	return null
}

let clearAllTimers = function clearAllTimers(ctx: FullCtx): void {
	ctx.timerStartTimeout = clearTimer(ctx.timerStartTimeout)
	ctx.timerRetryBackoff = clearTimer(ctx.timerRetryBackoff)
	ctx.timerRecoveryWindow = clearTimer(ctx.timerRecoveryWindow)
}

let finalize = function finalize(ctx: FullCtx, reason: unknown, kind: 'closed' | 'expired'): void {
	if (ctx.isFinalized) {
		return
	}

	ctx.isFinalized = true
	ctx.closedDeferred.resolve()
	ctx.ac.abort(reason)
	ctx.transport.destroy(reason)

	dbg.log('session finalized as %s: %O', kind, reason)
}

// Maps a TransportOutput event to a SessionEvent for the session FSM.
let mapTransportOutput = function mapTransportOutput(output: TransportOutput): SessionEvent | null {
	switch (output.type) {
		case 'transport.stream.started':
			return { type: 'session.transport.started', sessionId: output.sessionId }
		case 'transport.stream.disconnected':
			return {
				type: 'session.transport.disconnected',
				...('reason' in output ? { reason: output.reason } : {}),
			}
		case 'transport.stream.stopped':
			return {
				type: 'session.transport.stopped',
				...('sessionId' in output ? { sessionId: output.sessionId } : {}),
			}
		case 'transport.stream.failure': {
			let event: SessionEvent = { type: 'session.transport.failure', status: output.status }
			if (output.issues) {
				event = { ...event, issues: output.issues }
			}
			return event
		}
		case 'transport.stream.fatal':
			return { type: 'session.transport.fatal', error: output.error }
		default:
			return null
	}
}

export interface CreateSessionOptions {
	path: string
	description?: string
	recoveryWindow?: number
	startTimeout?: number
	retryBackoff?: number
}

export function createRuntime(
	driver: Driver,
	options: CreateSessionOptions,
	outerSignal?: AbortSignal
): SessionRuntime {
	let client = driver.createClient(CoordinationServiceDefinition) as CoordinationSessionClient
	let transport = new SessionTransport(client)

	let path = options.path
	let description = options.description ?? ''
	let retryBackoff = options.retryBackoff ?? 30
	let startTimeout = options.startTimeout ?? 3_000
	let recoveryWindow = options.recoveryWindow ?? 30_000

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
		env: {
			path,
			description,
			startTimeout,
			retryBackoff,
			recoveryWindow,

			ac: new AbortController(),
			transport,
			isFinalized: false,
			closedDeferred: createDeferred<void>(),

			timerStartTimeout: null,
			timerRetryBackoff: null,
			timerRecoveryWindow: null,
		},
		transition: sessionTransition,
		effects: {
			'session.effect.transport.connect': (ctx) => {
				dbg.log(
					'connecting transport to %s (sessionId=%s)',
					ctx.path,
					ctx.sessionId ?? 'new'
				)
				ctx.transport.connect({
					path: ctx.path,
					sessionId: ctx.sessionId,
					recoveryWindow: ctx.recoveryWindow,
					description: ctx.description,
				})
			},

			'session.effect.transport.stop': (ctx) => {
				dbg.log('gracefully stopping session %s on %s', ctx.sessionId, ctx.path)
				ctx.transport.stop()
			},

			'session.effect.transport.close': async (ctx) => {
				dbg.log('force closing transport on %s', ctx.path)
				ctx.transport.close()
			},

			'session.effect.timer.schedule_start_timeout': (ctx, _effect, runtime) => {
				dbg.log(
					'waiting up to %dms for server to accept session on %s',
					ctx.startTimeout,
					ctx.path
				)
				ctx.timerStartTimeout = clearTimer(ctx.timerStartTimeout)
				ctx.timerStartTimeout = setTimeout(() => {
					ctx.timerStartTimeout = null
					runtime.dispatch({ type: 'session.timer.start_timeout' })
				}, ctx.startTimeout)
			},

			'session.effect.timer.schedule_retry_backoff': (ctx, _effect, runtime) => {
				dbg.log('disconnected from %s, retrying in %dms', ctx.path, ctx.retryBackoff)
				ctx.timerRetryBackoff = clearTimer(ctx.timerRetryBackoff)
				ctx.timerRetryBackoff = setTimeout(() => {
					ctx.timerRetryBackoff = null
					runtime.dispatch({ type: 'session.timer.retry_backoff_elapsed' })
				}, ctx.retryBackoff)
			},

			'session.effect.timer.schedule_recovery_window': (ctx, _effect, runtime) => {
				if (ctx.timerRecoveryWindow) {
					return
				}

				dbg.log(
					'recovery window started (%dms) — session expires if not reconnected on %s',
					ctx.recoveryWindow,
					ctx.path
				)
				ctx.timerRecoveryWindow = setTimeout(() => {
					ctx.timerRecoveryWindow = null
					runtime.dispatch({ type: 'session.timer.recovery_window_expired' })
				}, ctx.recoveryWindow)
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

			'session.effect.runtime.mark_closed': async (ctx, effect) => {
				dbg.log('session closed on %s', ctx.path)
				clearAllTimers(ctx)
				finalize(ctx, effect.reason, 'closed')
			},

			'session.effect.runtime.mark_expired': async (ctx, effect) => {
				dbg.log('session expired on %s: %O', ctx.path, effect.reason)
				clearAllTimers(ctx)
				finalize(ctx, effect.reason, 'expired')
			},
		},
	})

	// Ingest transport events into the session FSM. The transport emits
	// lifecycle-significant events (started, disconnected, stopped, failure,
	// fatal) as an AsyncIterable — the session FSM maps and processes them.
	machineRuntime.ingest(transport.events, mapTransportOutput)

	if (outerSignal) {
		if (outerSignal.aborted) {
			dbg.log('not starting session on %s: signal already aborted', path)
			machineRuntime.dispatch({ type: 'session.destroy', reason: outerSignal.reason })
		} else {
			outerSignal.addEventListener(
				'abort',
				() => {
					dbg.log('outer signal aborted, stopping session on %s', path)
					machineRuntime.dispatch({
						type: 'session.destroy',
						reason: outerSignal.reason,
					})
				},
				{ once: true }
			)
		}
	}

	dbg.log('starting coordination session on %s (recoveryWindow=%dms)', path, recoveryWindow)
	machineRuntime.dispatch({ type: 'session.start' })

	let ctx = (): FullCtx => machineRuntime.ctx as unknown as FullCtx

	return {
		transport,

		get sessionId(): bigint | null {
			return machineRuntime.ctx.sessionId
		},

		get status(): SessionStatus {
			return machineRuntime.state
		},

		get signal(): AbortSignal {
			return (machineRuntime.ctx as unknown as FullCtx).ac.signal
		},

		async close(signal?: AbortSignal): Promise<void> {
			dbg.log('closing session %s on %s', machineRuntime.ctx.sessionId, path)
			machineRuntime.dispatch({ type: 'session.close' })
			let fullCtx = ctx()
			using combined = linkSignals(fullCtx.ac.signal, signal)
			await abortable(combined.signal, fullCtx.closedDeferred.promise)
		},

		destroy(reason?: unknown): void {
			dbg.log('destroying session %s on %s', machineRuntime.ctx.sessionId, path)
			machineRuntime.dispatch({ type: 'session.destroy', reason })
		},
	}
}
