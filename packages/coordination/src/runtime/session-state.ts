import { fail } from 'node:assert/strict'

import type { SessionResponse } from '@ydbjs/api/coordination'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { YDBError } from '@ydbjs/error'

import { SessionClosedError, SessionExpiredError } from '../errors.js'
import type { TransitionResult, TransitionRuntime } from '@ydbjs/fsm'

export type SessionState =
	| 'idle'
	| 'ready'
	| 'closed'
	| 'expired'
	| 'closing'
	| 'connecting'
	| 'reconnecting'

export type SessionCtx = {
	sessionId: bigint | null
	retryScheduled: boolean
	hasEverConnected: boolean
	recoveryScheduled: boolean
	startTimeoutScheduled: boolean
}

// Events the session FSM reacts to. Transport-level concerns (ping/pong,
// ready/reconnecting state, watch restoration) are handled autonomously
// by the transport — the session FSM only sees lifecycle-significant events.
export type SessionEvent =
	| { type: 'session.start' }
	| { type: 'session.close' }
	| { type: 'session.abort'; reason?: unknown }
	| { type: 'session.destroy'; reason?: unknown }
	| { type: 'session.transport.started'; sessionId: bigint }
	| { type: 'session.transport.disconnected'; reason?: unknown }
	| { type: 'session.transport.stopped'; sessionId?: bigint }
	| { type: 'session.transport.failure'; status: StatusIds_StatusCode; issues?: unknown[] }
	| { type: 'session.transport.fatal'; error: unknown }
	| { type: 'session.timer.start_timeout' }
	| { type: 'session.timer.retry_backoff_elapsed' }
	| { type: 'session.timer.recovery_window_expired' }

// Effects the session FSM emits. The transport is autonomous — the session
// FSM only issues high-level lifecycle commands: connect, stop, close.
export type SessionEffect =
	| { type: 'session.effect.transport.connect' }
	| { type: 'session.effect.transport.stop' }
	| { type: 'session.effect.transport.close' }
	| { type: 'session.effect.timer.schedule_start_timeout' }
	| { type: 'session.effect.timer.schedule_retry_backoff' }
	| { type: 'session.effect.timer.schedule_recovery_window' }
	| { type: 'session.effect.timer.clear_start_timeout' }
	| { type: 'session.effect.timer.clear_retry_backoff' }
	| { type: 'session.effect.timer.clear_recovery_window' }
	| { type: 'session.effect.runtime.mark_closed'; reason: unknown }
	| { type: 'session.effect.runtime.mark_expired'; reason: unknown }

export type SessionOutput =
	| { type: 'session.error'; error: unknown }
	| { type: 'session.ready'; sessionId: bigint }
	| { type: 'session.closed'; reason?: unknown }
	| { type: 'session.expired'; sessionId?: bigint; reason?: unknown }

export let createSessionCtx = function createSessionCtx(): SessionCtx {
	return {
		sessionId: null,
		hasEverConnected: false,
		recoveryScheduled: false,
		retryScheduled: false,
		startTimeoutScheduled: false,
	}
}

export let isTerminalSessionStatus = function isTerminalSessionStatus(
	status: StatusIds_StatusCode
): boolean {
	return (
		status === StatusIds_StatusCode.SESSION_EXPIRED ||
		status === StatusIds_StatusCode.BAD_SESSION
	)
}

export let isSessionLiveState = function isSessionLiveState(state: SessionState): boolean {
	return state === 'connecting' || state === 'ready' || state === 'reconnecting'
}

export let isSessionTerminalState = function isSessionTerminalState(state: SessionState): boolean {
	return state === 'closed' || state === 'expired'
}

export let toSessionFailureReason = function toSessionFailureReason(
	status: StatusIds_StatusCode,
	issues?: unknown[]
): YDBError {
	return new YDBError(status, (issues || []) as any[])
}

export let clearReconnectScheduling = function clearReconnectScheduling(ctx: SessionCtx): void {
	ctx.retryScheduled = false
	ctx.recoveryScheduled = false
}

export let clearAllScheduling = function clearAllScheduling(context: SessionCtx): void {
	context.retryScheduled = false
	context.recoveryScheduled = false
	context.startTimeoutScheduled = false
}

export let sessionTransition = function sessionTransition(
	ctx: SessionCtx,
	event: SessionEvent,
	runtime: TransitionRuntime<SessionState, SessionEvent, SessionOutput>
): TransitionResult<SessionState, SessionEffect> | void {
	let state = runtime.state

	// Global handlers — apply regardless of current state.

	if (state !== 'closed' && event.type === 'session.destroy') {
		clearAllScheduling(ctx)

		return {
			state: 'closed',
			effects: [
				{
					type: 'session.effect.runtime.mark_closed',
					reason: event.reason ?? new SessionClosedError('Session destroyed'),
				},
				{ type: 'session.effect.transport.close' },
				{ type: 'session.effect.timer.clear_start_timeout' },
				{ type: 'session.effect.timer.clear_retry_backoff' },
				{ type: 'session.effect.timer.clear_recovery_window' },
			],
		}
	}

	if (state !== 'closed' && state !== 'expired' && event.type === 'session.transport.fatal') {
		clearAllScheduling(ctx)

		return {
			state: 'expired',
			effects: [
				{ type: 'session.effect.runtime.mark_expired', reason: event.error },
				{ type: 'session.effect.transport.close' },
				{ type: 'session.effect.timer.clear_start_timeout' },
				{ type: 'session.effect.timer.clear_retry_backoff' },
				{ type: 'session.effect.timer.clear_recovery_window' },
			],
		}
	}

	// State-specific handlers.

	switch (state) {
		case 'idle': {
			if (event.type === 'session.start') {
				ctx.startTimeoutScheduled = true

				return {
					state: 'connecting',
					effects: [
						{ type: 'session.effect.transport.connect' },
						{ type: 'session.effect.timer.schedule_start_timeout' },
					],
				}
			}

			if (event.type === 'session.close' || event.type === 'session.abort') {
				clearAllScheduling(ctx)

				let reason =
					event.type === 'session.abort'
						? (event.reason ??
							new SessionClosedError('Session was closed before start'))
						: new SessionClosedError('Session was closed before start')

				return {
					state: 'closed',
					effects: [
						{
							type: 'session.effect.runtime.mark_closed',
							reason,
						},
					],
				}
			}

			return
		}

		case 'connecting': {
			if (event.type === 'session.transport.started') {
				ctx.sessionId = event.sessionId
				ctx.hasEverConnected = true
				ctx.startTimeoutScheduled = false
				clearReconnectScheduling(ctx)

				return {
					state: 'ready',
					effects: [
						{ type: 'session.effect.timer.clear_start_timeout' },
						{ type: 'session.effect.timer.clear_retry_backoff' },
						{ type: 'session.effect.timer.clear_recovery_window' },
					],
				}
			}

			if (
				event.type === 'session.transport.failure' &&
				isTerminalSessionStatus(event.status)
			) {
				clearAllScheduling(ctx)

				return {
					state: 'expired',
					effects: [
						{ type: 'session.effect.timer.clear_start_timeout' },
						{ type: 'session.effect.timer.clear_retry_backoff' },
						{ type: 'session.effect.timer.clear_recovery_window' },
						{
							type: 'session.effect.runtime.mark_expired',
							reason: toSessionFailureReason(event.status, event.issues),
						},
					],
				}
			}

			if (
				event.type === 'session.timer.start_timeout' ||
				event.type === 'session.transport.disconnected'
			) {
				ctx.startTimeoutScheduled = false

				if (!ctx.retryScheduled) {
					ctx.retryScheduled = true
				}

				if (!ctx.recoveryScheduled) {
					ctx.recoveryScheduled = true
				}

				return {
					state: 'reconnecting',
					effects: [
						{ type: 'session.effect.timer.clear_start_timeout' },
						{ type: 'session.effect.timer.schedule_retry_backoff' },
						{ type: 'session.effect.timer.schedule_recovery_window' },
					],
				}
			}

			if (event.type === 'session.close' || event.type === 'session.abort') {
				clearAllScheduling(ctx)

				return {
					state: 'closing',
					effects: [
						{ type: 'session.effect.transport.stop' },
						{ type: 'session.effect.timer.clear_start_timeout' },
						{ type: 'session.effect.timer.clear_retry_backoff' },
						{ type: 'session.effect.timer.clear_recovery_window' },
					],
				}
			}

			return
		}

		case 'ready': {
			if (event.type === 'session.transport.disconnected') {
				if (!ctx.retryScheduled) {
					ctx.retryScheduled = true
				}

				if (!ctx.recoveryScheduled) {
					ctx.recoveryScheduled = true
				}

				return {
					state: 'reconnecting',
					effects: [
						{ type: 'session.effect.timer.schedule_retry_backoff' },
						{ type: 'session.effect.timer.schedule_recovery_window' },
					],
				}
			}

			if (
				event.type === 'session.transport.failure' &&
				isTerminalSessionStatus(event.status)
			) {
				clearAllScheduling(ctx)

				return {
					state: 'expired',
					effects: [
						{ type: 'session.effect.timer.clear_start_timeout' },
						{ type: 'session.effect.timer.clear_retry_backoff' },
						{ type: 'session.effect.timer.clear_recovery_window' },
						{
							type: 'session.effect.runtime.mark_expired',
							reason: toSessionFailureReason(event.status, event.issues),
						},
					],
				}
			}

			if (event.type === 'session.close' || event.type === 'session.abort') {
				clearAllScheduling(ctx)

				return {
					state: 'closing',
					effects: [
						{ type: 'session.effect.transport.stop' },
						{ type: 'session.effect.timer.clear_start_timeout' },
						{ type: 'session.effect.timer.clear_retry_backoff' },
						{ type: 'session.effect.timer.clear_recovery_window' },
					],
				}
			}

			return
		}

		case 'reconnecting': {
			if (event.type === 'session.transport.started') {
				ctx.sessionId = event.sessionId
				ctx.hasEverConnected = true
				ctx.startTimeoutScheduled = false
				clearReconnectScheduling(ctx)

				return {
					state: 'ready',
					effects: [
						{ type: 'session.effect.timer.clear_start_timeout' },
						{ type: 'session.effect.timer.clear_retry_backoff' },
						{ type: 'session.effect.timer.clear_recovery_window' },
					],
				}
			}

			if (event.type === 'session.timer.retry_backoff_elapsed') {
				ctx.retryScheduled = false
				ctx.startTimeoutScheduled = true

				return {
					state: 'connecting',
					effects: [
						{ type: 'session.effect.transport.connect' },
						{ type: 'session.effect.timer.schedule_start_timeout' },
					],
				}
			}

			if (event.type === 'session.timer.recovery_window_expired') {
				ctx.recoveryScheduled = false
				ctx.retryScheduled = false
				ctx.startTimeoutScheduled = false

				return {
					state: 'expired',
					effects: [
						{ type: 'session.effect.timer.clear_start_timeout' },
						{ type: 'session.effect.timer.clear_retry_backoff' },
						{ type: 'session.effect.timer.clear_recovery_window' },
						{
							type: 'session.effect.runtime.mark_expired',
							reason: new SessionExpiredError('Recovery window expired'),
						},
					],
				}
			}

			if (
				event.type === 'session.transport.failure' &&
				isTerminalSessionStatus(event.status)
			) {
				clearAllScheduling(ctx)

				return {
					state: 'expired',
					effects: [
						{ type: 'session.effect.timer.clear_start_timeout' },
						{ type: 'session.effect.timer.clear_retry_backoff' },
						{ type: 'session.effect.timer.clear_recovery_window' },
						{
							type: 'session.effect.runtime.mark_expired',
							reason: toSessionFailureReason(event.status, event.issues),
						},
					],
				}
			}

			if (event.type === 'session.close' || event.type === 'session.abort') {
				clearAllScheduling(ctx)

				return {
					state: 'closing',
					effects: [
						{ type: 'session.effect.transport.stop' },
						{ type: 'session.effect.timer.clear_start_timeout' },
						{ type: 'session.effect.timer.clear_retry_backoff' },
						{ type: 'session.effect.timer.clear_recovery_window' },
					],
				}
			}

			return
		}

		case 'closing': {
			if (
				event.type === 'session.transport.stopped' ||
				event.type === 'session.transport.disconnected'
			) {
				clearAllScheduling(ctx)

				return {
					state: 'closed',
					effects: [
						{
							type: 'session.effect.runtime.mark_closed',
							reason: new SessionClosedError(),
						},
						{ type: 'session.effect.transport.close' },
						{ type: 'session.effect.timer.clear_start_timeout' },
						{ type: 'session.effect.timer.clear_retry_backoff' },
						{ type: 'session.effect.timer.clear_recovery_window' },
					],
				}
			}

			if (
				event.type === 'session.transport.failure' &&
				isTerminalSessionStatus(event.status)
			) {
				clearAllScheduling(ctx)

				return {
					state: 'expired',
					effects: [
						{
							type: 'session.effect.runtime.mark_expired',
							reason: toSessionFailureReason(event.status, event.issues),
						},
						{ type: 'session.effect.transport.close' },
						{ type: 'session.effect.timer.clear_start_timeout' },
						{ type: 'session.effect.timer.clear_retry_backoff' },
						{ type: 'session.effect.timer.clear_recovery_window' },
					],
				}
			}

			return
		}

		case 'closed':
		case 'expired':
			return

		default: {
			let exhaustiveCheck: never = state
			fail(`Unhandled session state: ${exhaustiveCheck}`)
		}
	}
}

// ── Transport FSM ─────────────────────────────────────────────────────────────

export type TransportState =
	| 'idle'
	| 'connecting'
	| 'ready'
	| 'disconnected'
	| 'stopping'
	| 'closed'

export type TransportCtx = {
	wasEverReady: boolean
}

export type TransportEvent =
	| { type: 'transport.connect' }
	| { type: 'transport.stop' }
	| { type: 'transport.close' }
	| { type: 'transport.destroy'; reason?: unknown }
	| { type: 'transport.stream.message'; response: SessionResponse }
	| { type: 'transport.stream.ended' }
	| { type: 'transport.stream.error'; error: unknown }

export type TransportEffect =
	| { type: 'transport.effect.open_stream' }
	| { type: 'transport.effect.close_stream' }
	| { type: 'transport.effect.send_pong'; opaque: bigint }
	| { type: 'transport.effect.send_stop' }
	| { type: 'transport.effect.mark_ready'; sessionId: bigint }
	| { type: 'transport.effect.mark_disconnected' }
	| { type: 'transport.effect.notify_watches' }
	| { type: 'transport.effect.finalize'; reason: unknown }

// Events the transport emits to the parent session FSM via AsyncIterable output.
export type TransportOutput =
	| { type: 'transport.stream.started'; sessionId: bigint }
	| { type: 'transport.stream.disconnected'; reason?: unknown }
	| { type: 'transport.stream.stopped'; sessionId?: bigint }
	| { type: 'transport.stream.failure'; status: StatusIds_StatusCode; issues?: unknown[] }
	| { type: 'transport.stream.fatal'; error: unknown }

export interface StreamOpenParams {
	path: string
	sessionId: bigint | null
	description: string
	recoveryWindow: number
}

export type CoordinationSessionClient = {
	session(
		request: AsyncIterable<StreamEnvelope>,
		options?: { signal?: AbortSignal }
	): AsyncIterable<SessionResponse>
}

export type StreamEnvelope = {
	request: {
		case: string
		value: unknown
	}
}

export type WatchChange = {
	dataChanged: boolean
	ownersChanged: boolean
}

// ── Message classification ────────────────────────────────────────────────────

type ClassifiedMessage =
	| { kind: 'ping'; opaque: bigint }
	| { kind: 'started'; sessionId: bigint }
	| { kind: 'stopped'; sessionId?: bigint }
	| { kind: 'failure'; status: StatusIds_StatusCode; issues?: unknown[] }
	| { kind: 'response'; reqId: bigint; response: SessionResponse }
	| { kind: 'watch'; reqId: bigint; change: WatchChange }

export let classifyMessage = function classifyMessage(
	response: SessionResponse
): ClassifiedMessage | null {
	if (response.response.case === 'describeSemaphoreChanged') {
		let value = response.response.value
		return {
			kind: 'watch',
			reqId: value.reqId,
			change: { dataChanged: value.dataChanged, ownersChanged: value.ownersChanged },
		}
	}

	let reqId = extractReqId(response)
	if (reqId !== null) {
		return { kind: 'response', reqId, response }
	}

	if (response.response.case === 'ping') {
		return { kind: 'ping', opaque: response.response.value.opaque }
	}

	if (response.response.case === 'sessionStarted') {
		return { kind: 'started', sessionId: response.response.value.sessionId }
	}

	if (response.response.case === 'sessionStopped') {
		return { kind: 'stopped', sessionId: response.response.value.sessionId }
	}

	if (response.response.case === 'failure') {
		return {
			kind: 'failure',
			status: response.response.value.status as StatusIds_StatusCode,
			issues: response.response.value.issues,
		}
	}

	return null
}

export let extractReqId = function extractReqId(response: SessionResponse): bigint | null {
	switch (response.response.case) {
		case 'acquireSemaphorePending':
		case 'acquireSemaphoreResult':
		case 'releaseSemaphoreResult':
		case 'createSemaphoreResult':
		case 'updateSemaphoreResult':
		case 'deleteSemaphoreResult':
		case 'describeSemaphoreResult':
			return response.response.value.reqId
		default:
			return null
	}
}

export let isAbortError = function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === 'AbortError'
}

// ── Transport FSM transition ──────────────────────────────────────────────────

export let transportTransition = function transportTransition(
	ctx: TransportCtx,
	event: TransportEvent,
	runtime: TransitionRuntime<TransportState, TransportEvent, TransportOutput>
): TransitionResult<TransportState, TransportEffect> | void {
	let state = runtime.state

	// Global: destroy from any non-closed state.
	if (state !== 'closed' && event.type === 'transport.destroy') {
		return {
			state: 'closed',
			effects: [
				{ type: 'transport.effect.close_stream' },
				{
					type: 'transport.effect.finalize',
					reason: event.reason ?? new Error('Transport destroyed'),
				},
			],
		}
	}

	switch (state) {
		case 'idle': {
			if (event.type === 'transport.connect') {
				return {
					state: 'connecting',
					effects: [{ type: 'transport.effect.open_stream' }],
				}
			}

			if (event.type === 'transport.close') {
				return {
					state: 'closed',
					effects: [
						{
							type: 'transport.effect.finalize',
							reason: new Error('Transport closed before connecting'),
						},
					],
				}
			}

			return
		}

		case 'connecting': {
			if (event.type === 'transport.stream.message') {
				let msg = classifyMessage(event.response)
				if (!msg) {
					return
				}

				if (msg.kind === 'ping') {
					return { effects: [{ type: 'transport.effect.send_pong', opaque: msg.opaque }] }
				}

				if (msg.kind === 'started') {
					let wasReconnect = ctx.wasEverReady
					ctx.wasEverReady = true
					return {
						state: 'ready',
						effects: [
							{ type: 'transport.effect.mark_ready', sessionId: msg.sessionId },
							...(wasReconnect
								? [
										{
											type: 'transport.effect.notify_watches',
										} satisfies TransportEffect,
									]
								: []),
						],
					}
				}

				if (msg.kind === 'failure') {
					let output: TransportOutput = {
						type: 'transport.stream.failure',
						status: msg.status,
					}
					if (msg.issues) {
						output = { ...output, issues: msg.issues }
					}
					runtime.emit(output)
					return
				}

				// Responses and watches can arrive while connecting (unlikely but safe).
				if (msg.kind === 'response' || msg.kind === 'watch') {
					return
				}

				return
			}

			if (
				event.type === 'transport.stream.ended' ||
				event.type === 'transport.stream.error'
			) {
				return {
					state: 'disconnected',
					effects: [
						{ type: 'transport.effect.close_stream' },
						{ type: 'transport.effect.mark_disconnected' },
					],
				}
			}

			if (event.type === 'transport.stop' || event.type === 'transport.close') {
				return {
					state: 'closed',
					effects: [
						{ type: 'transport.effect.close_stream' },
						{
							type: 'transport.effect.finalize',
							reason: new Error('Transport closed'),
						},
					],
				}
			}

			return
		}

		case 'ready': {
			if (event.type === 'transport.stream.message') {
				let msg = classifyMessage(event.response)
				if (!msg) {
					return
				}

				if (msg.kind === 'ping') {
					return { effects: [{ type: 'transport.effect.send_pong', opaque: msg.opaque }] }
				}

				if (msg.kind === 'failure') {
					let output: TransportOutput = {
						type: 'transport.stream.failure',
						status: msg.status,
					}
					if (msg.issues) {
						output = { ...output, issues: msg.issues }
					}
					runtime.emit(output)
					return
				}

				// response and watch are handled inline by effects (not FSM concern)
				return
			}

			if (
				event.type === 'transport.stream.ended' ||
				event.type === 'transport.stream.error'
			) {
				return {
					state: 'disconnected',
					effects: [
						{ type: 'transport.effect.close_stream' },
						{ type: 'transport.effect.mark_disconnected' },
					],
				}
			}

			if (event.type === 'transport.stop') {
				return {
					state: 'stopping',
					effects: [{ type: 'transport.effect.send_stop' }],
				}
			}

			if (event.type === 'transport.close') {
				return {
					state: 'closed',
					effects: [
						{ type: 'transport.effect.close_stream' },
						{
							type: 'transport.effect.finalize',
							reason: new Error('Transport closed'),
						},
					],
				}
			}

			if (event.type === 'transport.connect') {
				// Reconnect request while already ready — re-open stream.
				return {
					state: 'connecting',
					effects: [
						{ type: 'transport.effect.mark_disconnected' },
						{ type: 'transport.effect.open_stream' },
					],
				}
			}

			return
		}

		case 'disconnected': {
			if (event.type === 'transport.connect') {
				return {
					state: 'connecting',
					effects: [{ type: 'transport.effect.open_stream' }],
				}
			}

			if (event.type === 'transport.stop' || event.type === 'transport.close') {
				return {
					state: 'closed',
					effects: [
						{
							type: 'transport.effect.finalize',
							reason: new Error('Transport closed'),
						},
					],
				}
			}

			return
		}

		case 'stopping': {
			if (event.type === 'transport.stream.message') {
				let msg = classifyMessage(event.response)
				if (!msg) {
					return
				}

				if (msg.kind === 'ping') {
					return { effects: [{ type: 'transport.effect.send_pong', opaque: msg.opaque }] }
				}

				// Server confirmed graceful stop. Emit the event so the parent
				// session FSM can transition to closed and call transport.close()
				// when it's ready. The transport stays in 'stopping' — finalization
				// happens when the parent explicitly closes.
				if (msg.kind === 'stopped') {
					let stoppedOutput: TransportOutput = { type: 'transport.stream.stopped' }
					if (msg.sessionId !== undefined) {
						stoppedOutput = { ...stoppedOutput, sessionId: msg.sessionId }
					}
					runtime.emit(stoppedOutput)
					return { effects: [{ type: 'transport.effect.mark_disconnected' }] }
				}

				if (msg.kind === 'failure') {
					let output: TransportOutput = {
						type: 'transport.stream.failure',
						status: msg.status,
					}
					if (msg.issues) {
						output = { ...output, issues: msg.issues }
					}
					runtime.emit(output)
					return
				}

				return
			}

			// Stream dropped while waiting for graceful stop — treat the same
			// as stopped: emit disconnected so the parent can react.
			if (
				event.type === 'transport.stream.ended' ||
				event.type === 'transport.stream.error'
			) {
				runtime.emit({ type: 'transport.stream.disconnected' })
				return { effects: [{ type: 'transport.effect.mark_disconnected' }] }
			}

			// Parent decided to force-close while waiting for graceful stop.
			if (event.type === 'transport.close') {
				return {
					state: 'closed',
					effects: [
						{ type: 'transport.effect.close_stream' },
						{
							type: 'transport.effect.finalize',
							reason: new Error('Transport closed'),
						},
					],
				}
			}

			return
		}

		case 'closed':
			return

		default: {
			let exhaustiveCheck: never = state
			throw new Error(`Unhandled transport state: ${exhaustiveCheck}`)
		}
	}
}
