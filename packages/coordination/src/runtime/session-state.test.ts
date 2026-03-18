import { expect, test } from 'vitest'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import type { TransitionRuntime } from '@ydbjs/fsm'

import { SessionClosedError, SessionExpiredError } from '../errors.ts'

import {
	type SessionCtx,
	type SessionEffect,
	type SessionEvent,
	type SessionOutput,
	type SessionState,
	clearAllScheduling,
	clearReconnectScheduling,
	createSessionCtx,
	isSessionLiveState,
	isSessionTerminalState,
	isTerminalSessionStatus,
	sessionTransition,
	toSessionFailureReason,
} from './session-state.ts'

let makeRuntime = function makeRuntime(
	state: SessionState
): TransitionRuntime<SessionState, SessionEvent, SessionOutput> {
	return {
		state,
		signal: new AbortController().signal,
		emit() {},
		dispatch() {},
	}
}

let transition = function transition(
	state: SessionState,
	event: SessionEvent,
	context?: Partial<SessionCtx>
): {
	state: SessionState
	context: SessionCtx
	effects: SessionEffect[]
} {
	let nextContext: SessionCtx = {
		...createSessionCtx(),
		...context,
	}

	let result = sessionTransition(nextContext, event, makeRuntime(state))

	return {
		state: result?.state ?? state,
		context: nextContext,
		effects: result?.effects ?? [],
	}
}

test('creates empty initial session context', () => {
	let context = createSessionCtx()

	expect(context).toEqual({
		sessionId: null,
		hasEverConnected: false,
		recoveryScheduled: false,
		retryScheduled: false,
		startTimeoutScheduled: false,
	})
})

test('recognizes terminal protocol statuses', () => {
	expect(isTerminalSessionStatus(StatusIds_StatusCode.SESSION_EXPIRED)).toBe(true)
	expect(isTerminalSessionStatus(StatusIds_StatusCode.BAD_SESSION)).toBe(true)
	expect(isTerminalSessionStatus(StatusIds_StatusCode.SUCCESS)).toBe(false)
})

test('recognizes live session states', () => {
	expect(isSessionLiveState('connecting')).toBe(true)
	expect(isSessionLiveState('ready')).toBe(true)
	expect(isSessionLiveState('reconnecting')).toBe(true)
	expect(isSessionLiveState('closing')).toBe(false)
	expect(isSessionLiveState('closed')).toBe(false)
	expect(isSessionLiveState('expired')).toBe(false)
	expect(isSessionLiveState('idle')).toBe(false)
})

test('recognizes terminal session states', () => {
	expect(isSessionTerminalState('closed')).toBe(true)
	expect(isSessionTerminalState('expired')).toBe(true)
	expect(isSessionTerminalState('ready')).toBe(false)
	expect(isSessionTerminalState('reconnecting')).toBe(false)
})

test('clears reconnect scheduling flags', () => {
	let context: SessionCtx = {
		...createSessionCtx(),
		recoveryScheduled: true,
		retryScheduled: true,
		startTimeoutScheduled: true,
	}

	clearReconnectScheduling(context)

	expect(context).toEqual({
		sessionId: null,
		hasEverConnected: false,
		recoveryScheduled: false,
		retryScheduled: false,
		startTimeoutScheduled: true,
	})
})

test('clears all scheduling flags', () => {
	let context: SessionCtx = {
		...createSessionCtx(),
		recoveryScheduled: true,
		retryScheduled: true,
		startTimeoutScheduled: true,
	}

	clearAllScheduling(context)

	expect(context).toEqual({
		sessionId: null,
		hasEverConnected: false,
		recoveryScheduled: false,
		retryScheduled: false,
		startTimeoutScheduled: false,
	})
})

test('converts protocol failure to ydb error', () => {
	let error = toSessionFailureReason(StatusIds_StatusCode.BAD_SESSION, [])

	expect(error).toBeInstanceOf(Error)
	expect(String(error)).toContain('BAD_SESSION')
})

test('moves from idle to connecting on session start', () => {
	let result = transition('idle', { type: 'session.start' })

	expect(result.state).toBe('connecting')
	expect(result.context.startTimeoutScheduled).toBe(true)
	expect(result.effects).toEqual([
		{ type: 'session.effect.transport.connect' },
		{ type: 'session.effect.timer.schedule_start_timeout' },
	])
})

test('closes directly from idle on close', () => {
	let result = transition('idle', { type: 'session.close' })

	expect(result.state).toBe('closed')
	expect(result.effects).toEqual([
		{
			type: 'session.effect.runtime.mark_closed',
			reason: new SessionClosedError('Session was closed before start'),
		},
	])
})

test('moves from connecting to ready on first session start', () => {
	let result = transition(
		'connecting',
		{ type: 'session.transport.started', sessionId: 42n },
		{
			startTimeoutScheduled: true,
			hasEverConnected: false,
		}
	)

	expect(result.state).toBe('ready')
	expect(result.context.sessionId).toBe(42n)
	expect(result.context.hasEverConnected).toBe(true)
	expect(result.context.startTimeoutScheduled).toBe(false)
	expect(result.context.retryScheduled).toBe(false)
	expect(result.context.recoveryScheduled).toBe(false)
	expect(result.effects).toEqual([
		{ type: 'session.effect.timer.clear_start_timeout' },
		{ type: 'session.effect.timer.clear_retry_backoff' },
		{ type: 'session.effect.timer.clear_recovery_window' },
	])
})

test('moves from connecting to ready after reconnect', () => {
	let result = transition(
		'connecting',
		{ type: 'session.transport.started', sessionId: 42n },
		{
			startTimeoutScheduled: true,
			hasEverConnected: true,
			retryScheduled: true,
		}
	)

	expect(result.state).toBe('ready')
	expect(result.context.sessionId).toBe(42n)
	expect(result.context.hasEverConnected).toBe(true)
	expect(result.context.startTimeoutScheduled).toBe(false)
	expect(result.context.retryScheduled).toBe(false)
	expect(result.context.recoveryScheduled).toBe(false)
	expect(result.effects).toEqual([
		{ type: 'session.effect.timer.clear_start_timeout' },
		{ type: 'session.effect.timer.clear_retry_backoff' },
		{ type: 'session.effect.timer.clear_recovery_window' },
	])
})

test('moves from connecting to reconnecting on start timeout', () => {
	let result = transition(
		'connecting',
		{ type: 'session.timer.start_timeout' },
		{
			startTimeoutScheduled: true,
		}
	)

	expect(result.state).toBe('reconnecting')
	expect(result.context.startTimeoutScheduled).toBe(false)
	expect(result.context.retryScheduled).toBe(true)
	expect(result.context.recoveryScheduled).toBe(true)
	expect(result.effects).toEqual([
		{ type: 'session.effect.timer.clear_start_timeout' },
		{ type: 'session.effect.timer.schedule_retry_backoff' },
		{ type: 'session.effect.timer.schedule_recovery_window' },
	])
})

test('moves from ready to reconnecting on disconnect', () => {
	let result = transition('ready', { type: 'session.transport.disconnected' })

	expect(result.state).toBe('reconnecting')
	expect(result.context.retryScheduled).toBe(true)
	expect(result.context.recoveryScheduled).toBe(true)
	expect(result.effects).toEqual([
		{ type: 'session.effect.timer.schedule_retry_backoff' },
		{ type: 'session.effect.timer.schedule_recovery_window' },
	])
})

test('moves from reconnecting to connecting on retry backoff elapsed', () => {
	let result = transition(
		'reconnecting',
		{ type: 'session.timer.retry_backoff_elapsed' },
		{
			retryScheduled: true,
			recoveryScheduled: true,
		}
	)

	expect(result.state).toBe('connecting')
	expect(result.context.retryScheduled).toBe(false)
	expect(result.context.recoveryScheduled).toBe(true)
	expect(result.context.startTimeoutScheduled).toBe(true)
	expect(result.effects).toEqual([
		{ type: 'session.effect.transport.connect' },
		{ type: 'session.effect.timer.schedule_start_timeout' },
	])
})

test('moves from reconnecting to ready after reconnect', () => {
	let result = transition(
		'reconnecting',
		{ type: 'session.transport.started', sessionId: 99n },
		{
			hasEverConnected: true,
			retryScheduled: true,
			recoveryScheduled: true,
		}
	)

	expect(result.state).toBe('ready')
	expect(result.context.sessionId).toBe(99n)
	expect(result.context.retryScheduled).toBe(false)
	expect(result.context.recoveryScheduled).toBe(false)
	expect(result.effects).toEqual([
		{ type: 'session.effect.timer.clear_start_timeout' },
		{ type: 'session.effect.timer.clear_retry_backoff' },
		{ type: 'session.effect.timer.clear_recovery_window' },
	])
})

test('expires session when recovery window elapses', () => {
	let result = transition(
		'reconnecting',
		{ type: 'session.timer.recovery_window_expired' },
		{
			retryScheduled: true,
			recoveryScheduled: true,
			startTimeoutScheduled: true,
		}
	)

	expect(result.state).toBe('expired')
	expect(result.context.retryScheduled).toBe(false)
	expect(result.context.recoveryScheduled).toBe(false)
	expect(result.context.startTimeoutScheduled).toBe(false)
	expect(result.effects).toEqual([
		{ type: 'session.effect.timer.clear_start_timeout' },
		{ type: 'session.effect.timer.clear_retry_backoff' },
		{ type: 'session.effect.timer.clear_recovery_window' },
		{
			type: 'session.effect.runtime.mark_expired',
			reason: new SessionExpiredError('Recovery window expired'),
		},
	])
})

test('moves from ready to closing on close request', () => {
	let result = transition(
		'ready',
		{ type: 'session.close' },
		{
			startTimeoutScheduled: true,
			retryScheduled: true,
			recoveryScheduled: true,
		}
	)

	expect(result.state).toBe('closing')
	expect(result.context.startTimeoutScheduled).toBe(false)
	expect(result.context.retryScheduled).toBe(false)
	expect(result.context.recoveryScheduled).toBe(false)
	expect(result.effects).toEqual([
		{ type: 'session.effect.transport.stop' },
		{ type: 'session.effect.timer.clear_start_timeout' },
		{ type: 'session.effect.timer.clear_retry_backoff' },
		{ type: 'session.effect.timer.clear_recovery_window' },
	])
})

test('moves from closing to closed on transport stopped', () => {
	let result = transition(
		'closing',
		{ type: 'session.transport.stopped', sessionId: 7n },
		{
			startTimeoutScheduled: true,
			retryScheduled: true,
			recoveryScheduled: true,
		}
	)

	expect(result.state).toBe('closed')
	expect(result.context.startTimeoutScheduled).toBe(false)
	expect(result.context.retryScheduled).toBe(false)
	expect(result.context.recoveryScheduled).toBe(false)
	expect(result.effects).toEqual([
		{
			type: 'session.effect.runtime.mark_closed',
			reason: new SessionClosedError(),
		},
		{ type: 'session.effect.transport.close' },
		{ type: 'session.effect.timer.clear_start_timeout' },
		{ type: 'session.effect.timer.clear_retry_backoff' },
		{ type: 'session.effect.timer.clear_recovery_window' },
	])
})

test('expires from ready on terminal protocol failure', () => {
	let result = transition('ready', {
		type: 'session.transport.failure',
		status: StatusIds_StatusCode.SESSION_EXPIRED,
		issues: [],
	})

	expect(result.state).toBe('expired')
	expect(result.effects[0]).toEqual({ type: 'session.effect.timer.clear_start_timeout' })
	expect(result.effects[1]).toEqual({ type: 'session.effect.timer.clear_retry_backoff' })
	expect(result.effects[2]).toEqual({ type: 'session.effect.timer.clear_recovery_window' })
	expect(result.effects[3]?.type).toBe('session.effect.runtime.mark_expired')
})

test('expires from connecting on transport fatal error', () => {
	let error = new Error('boom')
	let result = transition('connecting', { type: 'session.transport.fatal', error })

	expect(result.state).toBe('expired')
	expect(result.effects).toEqual([
		{ type: 'session.effect.runtime.mark_expired', reason: error },
		{ type: 'session.effect.transport.close' },
		{ type: 'session.effect.timer.clear_start_timeout' },
		{ type: 'session.effect.timer.clear_retry_backoff' },
		{ type: 'session.effect.timer.clear_recovery_window' },
	])
})

test('closes from any non-closed state on destroy', () => {
	let reason = new Error('manual destroy')
	let result = transition('ready', { type: 'session.destroy', reason })

	expect(result.state).toBe('closed')
	expect(result.effects).toEqual([
		{ type: 'session.effect.runtime.mark_closed', reason },
		{ type: 'session.effect.transport.close' },
		{ type: 'session.effect.timer.clear_start_timeout' },
		{ type: 'session.effect.timer.clear_retry_backoff' },
		{ type: 'session.effect.timer.clear_recovery_window' },
	])
})

test('ignores events after closed', () => {
	let result = transition('closed', { type: 'session.start' })

	expect(result.state).toBe('closed')
	expect(result.effects).toEqual([])
})

test('ignores events after expired', () => {
	let result = transition('expired', { type: 'session.close' })

	expect(result.state).toBe('expired')
	expect(result.effects).toEqual([])
})
