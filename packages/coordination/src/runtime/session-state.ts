import { fail } from 'node:assert/strict'

import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { YDBError } from '@ydbjs/error'
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

export type SessionEvent =
	| { type: 'session.start' }
	| { type: 'session.close' }
	| { type: 'session.abort'; reason?: unknown }
	| { type: 'session.destroy'; reason?: unknown }
	| { type: 'session.stream.connected' }
	| { type: 'session.stream.disconnected'; reason?: unknown }
	| { type: 'session.stream.response.ping'; opaque: bigint }
	| { type: 'session.stream.response.started'; sessionId: bigint }
	| { type: 'session.stream.response.stopped'; sessionId?: bigint }
	| { type: 'session.stream.response.failure'; status: StatusIds_StatusCode; issues?: unknown[] }
	| { type: 'session.timer.start_timeout' }
	| { type: 'session.timer.retry_backoff_elapsed' }
	| { type: 'session.timer.recovery_window_expired' }
	| { type: 'session.internal.fatal'; error: unknown }

export type SessionEffect =
	| { type: 'session.effect.stream.open' }
	| { type: 'session.effect.stream.close' }
	| { type: 'session.effect.stream.send_stop' }
	| { type: 'session.effect.stream.send_pong'; opaque: bigint }
	| { type: 'session.effect.timer.schedule_start_timeout' }
	| { type: 'session.effect.timer.schedule_retry_backoff' }
	| { type: 'session.effect.timer.schedule_recovery_window' }
	| { type: 'session.effect.timer.clear_start_timeout' }
	| { type: 'session.effect.timer.clear_retry_backoff' }
	| { type: 'session.effect.timer.clear_recovery_window' }
	| { type: 'session.effect.runtime.emit_error'; error: unknown }
	| { type: 'session.effect.runtime.mark_ready'; sessionId: bigint }
	| { type: 'session.effect.runtime.mark_closed'; reason: unknown }
	| { type: 'session.effect.runtime.mark_expired'; reason: unknown }
	| { type: 'session.effect.runtime.restore_after_reconnect' }

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
	if (state !== 'closed' && event.type === 'session.destroy') {
		clearAllScheduling(ctx)

		return {
			state: 'closed',
			effects: [
				{ type: 'session.effect.stream.close' },
				{ type: 'session.effect.timer.clear_start_timeout' },
				{ type: 'session.effect.timer.clear_retry_backoff' },
				{ type: 'session.effect.timer.clear_recovery_window' },
				{
					type: 'session.effect.runtime.mark_closed',
					reason: event.reason ?? new Error('Session destroyed'),
				},
			],
		}
	}

	if (state !== 'closed' && state !== 'expired' && event.type === 'session.internal.fatal') {
		clearAllScheduling(ctx)

		return {
			state: 'expired',
			effects: [
				{ type: 'session.effect.stream.close' },
				{ type: 'session.effect.timer.clear_start_timeout' },
				{ type: 'session.effect.timer.clear_retry_backoff' },
				{ type: 'session.effect.timer.clear_recovery_window' },
				{ type: 'session.effect.runtime.emit_error', error: event.error },
				{ type: 'session.effect.runtime.mark_expired', reason: event.error },
			],
		}
	}

	switch (state) {
		case 'idle': {
			if (event.type === 'session.start') {
				ctx.startTimeoutScheduled = true

				return {
					state: 'connecting',
					effects: [
						{ type: 'session.effect.stream.open' },
						{ type: 'session.effect.timer.schedule_start_timeout' },
					],
				}
			}

			if (event.type === 'session.close' || event.type === 'session.abort') {
				clearAllScheduling(ctx)

				let reason =
					event.type === 'session.abort'
						? (event.reason ?? new Error('Session was closed before start'))
						: new Error('Session was closed before start')

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
			if (event.type === 'session.stream.connected') {
				return
			}

			if (event.type === 'session.stream.response.started') {
				let isReconnect = ctx.hasEverConnected

				ctx.sessionId = event.sessionId
				ctx.hasEverConnected = true
				ctx.startTimeoutScheduled = false
				clearReconnectScheduling(ctx)

				return {
					state: 'ready',
					effects: [
						{ type: 'session.effect.runtime.mark_ready', sessionId: event.sessionId },
						{ type: 'session.effect.timer.clear_start_timeout' },
						{ type: 'session.effect.timer.clear_retry_backoff' },
						{ type: 'session.effect.timer.clear_recovery_window' },
						...(isReconnect
							? [
									{
										type: 'session.effect.runtime.restore_after_reconnect',
									} satisfies SessionEffect,
								]
							: []),
					],
				}
			}

			if (event.type === 'session.stream.response.ping') {
				return {
					effects: [{ type: 'session.effect.stream.send_pong', opaque: event.opaque }],
				}
			}

			if (
				event.type === 'session.stream.response.failure' &&
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
				event.type === 'session.stream.disconnected'
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
						{ type: 'session.effect.stream.send_stop' },
						{ type: 'session.effect.timer.clear_start_timeout' },
						{ type: 'session.effect.timer.clear_retry_backoff' },
						{ type: 'session.effect.timer.clear_recovery_window' },
					],
				}
			}

			return
		}

		case 'ready': {
			if (event.type === 'session.stream.response.ping') {
				return {
					effects: [{ type: 'session.effect.stream.send_pong', opaque: event.opaque }],
				}
			}

			if (event.type === 'session.stream.disconnected') {
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
				event.type === 'session.stream.response.failure' &&
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
						{ type: 'session.effect.stream.send_stop' },
						{ type: 'session.effect.timer.clear_start_timeout' },
						{ type: 'session.effect.timer.clear_retry_backoff' },
						{ type: 'session.effect.timer.clear_recovery_window' },
					],
				}
			}

			return
		}

		case 'reconnecting': {
			if (event.type === 'session.stream.response.ping') {
				return {
					effects: [{ type: 'session.effect.stream.send_pong', opaque: event.opaque }],
				}
			}

			if (event.type === 'session.stream.response.started') {
				let isReconnect = ctx.hasEverConnected

				ctx.sessionId = event.sessionId
				ctx.hasEverConnected = true
				ctx.startTimeoutScheduled = false
				clearReconnectScheduling(ctx)

				return {
					state: 'ready',
					effects: [
						{ type: 'session.effect.runtime.mark_ready', sessionId: event.sessionId },
						{ type: 'session.effect.timer.clear_start_timeout' },
						{ type: 'session.effect.timer.clear_retry_backoff' },
						{ type: 'session.effect.timer.clear_recovery_window' },
						...(isReconnect
							? [
									{
										type: 'session.effect.runtime.restore_after_reconnect',
									} satisfies SessionEffect,
								]
							: []),
					],
				}
			}

			if (event.type === 'session.timer.retry_backoff_elapsed') {
				ctx.retryScheduled = false
				ctx.startTimeoutScheduled = true

				return {
					state: 'connecting',
					effects: [
						{ type: 'session.effect.stream.open' },
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
							reason: new Error('Recovery window expired'),
						},
					],
				}
			}

			if (
				event.type === 'session.stream.response.failure' &&
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
						{ type: 'session.effect.stream.send_stop' },
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
				event.type === 'session.stream.response.stopped' ||
				event.type === 'session.stream.disconnected'
			) {
				clearAllScheduling(ctx)

				return {
					state: 'closed',
					effects: [
						{ type: 'session.effect.stream.close' },
						{ type: 'session.effect.timer.clear_start_timeout' },
						{ type: 'session.effect.timer.clear_retry_backoff' },
						{ type: 'session.effect.timer.clear_recovery_window' },
						{
							type: 'session.effect.runtime.mark_closed',
							reason: new Error('Session closed'),
						},
					],
				}
			}

			if (event.type === 'session.stream.response.ping') {
				return {
					effects: [{ type: 'session.effect.stream.send_pong', opaque: event.opaque }],
				}
			}

			if (
				event.type === 'session.stream.response.failure' &&
				isTerminalSessionStatus(event.status)
			) {
				clearAllScheduling(ctx)

				return {
					state: 'expired',
					effects: [
						{ type: 'session.effect.stream.close' },
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
