import { expect, test } from 'vitest'

import type { TransitionRuntime } from '@ydbjs/fsm'
import { YDBError } from '@ydbjs/error'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'

import {
	type BufferedMessage,
	type WriterCtx,
	type WriterEffect,
	type WriterEvent,
	type WriterLimits,
	type WriterOutput,
	type WriterState,
	createWriterCtx,
	isRetryableWriterError,
	writerTransition,
} from './writer-state.ts'

let limits: WriterLimits = {
	maxInflightCount: 1000,
	maxBufferBytes: 256n * 1024n * 1024n,
	maxBatchBytes: 48n * 1024n * 1024n,
	maxPayloadBytes: 48n * 1024n * 1024n,
}

let ctxWith = function ctxWith(overrides: Partial<WriterCtx> = {}): WriterCtx {
	return { ...createWriterCtx(limits), ...overrides }
}

let msg = function msg(byte: number, seqNo = 0n): BufferedMessage {
	return { data: new Uint8Array([byte]), uncompressedSize: 1n, seqNo, createdAt: new Date(0) }
}

type Driven = {
	state: WriterState
	effects: WriterEffect[]
	emitted: WriterOutput[]
	dispatched: WriterEvent[]
	ctx: WriterCtx
}

let drive = function drive(state: WriterState, event: WriterEvent, ctx: WriterCtx): Driven {
	let emitted: WriterOutput[] = []
	let dispatched: WriterEvent[] = []
	let runtime: TransitionRuntime<WriterState, WriterEvent, WriterOutput> = {
		state,
		signal: new AbortController().signal,
		emit: (out) => emitted.push(out),
		dispatch: (evt) => dispatched.push(evt),
	}

	let result = writerTransition(ctx, event, runtime)

	return {
		state: result?.state ?? state,
		effects: result?.effects ?? [],
		emitted,
		dispatched,
		ctx,
	}
}

let effectTypes = function effectTypes(effects: WriterEffect[]): string[] {
	return effects.map((effect) => effect.type)
}

// ── error classification ────────────────────────────────────────────────────────

test('classifies a missing error as retryable', () => {
	expect(isRetryableWriterError(undefined)).toBe(true)
})

test('classifies UNAVAILABLE as retryable', () => {
	expect(isRetryableWriterError(new YDBError(StatusIds_StatusCode.UNAVAILABLE, []))).toBe(true)
})

test('classifies conditionally-retryable SESSION_EXPIRED as retryable for idempotent writes', () => {
	expect(isRetryableWriterError(new YDBError(StatusIds_StatusCode.SESSION_EXPIRED, []))).toBe(
		true
	)
})

test('classifies SCHEME_ERROR as fatal', () => {
	expect(isRetryableWriterError(new YDBError(StatusIds_StatusCode.SCHEME_ERROR, []))).toBe(false)
})

test('classifies an over-size complaint as fatal', () => {
	expect(isRetryableWriterError(new Error('message is larger than max allowed'))).toBe(false)
})

// ── idle ────────────────────────────────────────────────────────────────────────

test('connects with getLastSeqNo on start', () => {
	let d = drive('idle', { type: 'writer.start' }, ctxWith())

	expect(d.state).toBe('connecting')
	let connect = d.effects.find((e) => e.type === 'writer.effect.transport.connect')
	expect(connect).toEqual({ type: 'writer.effect.transport.connect', getLastSeqNo: true })
	expect(effectTypes(d.effects)).toContain('writer.effect.timer.schedule')
})

test('buffers a write received before connecting', () => {
	let ctx = ctxWith()
	let d = drive('idle', { type: 'writer.write', message: msg(1) }, ctx)

	expect(d.state).toBe('idle')
	expect(d.ctx.bufferLength).toBe(1)
	expect(d.ctx.seqNoMode).toBe('auto')
})

test('records manual mode from a seqNo-carrying write', () => {
	let ctx = ctxWith()
	drive('idle', { type: 'writer.write', message: msg(1, 5n) }, ctx)

	expect(ctx.seqNoMode).toBe('manual')
	expect(ctx.highestUserSeqNo).toBe(5n)
	expect(ctx.lastSeqNo).toBe(5n)
})

// ── connecting → ready (init + seqno recovery) ──────────────────────────────────

test('recovers the server high-water mark on first init in auto mode', () => {
	let ctx = ctxWith({ seqNoMode: 'auto' })
	let d = drive(
		'connecting',
		{ type: 'writer.stream.init_response', sessionId: 's1', lastSeqNo: 42n },
		ctx
	)

	expect(d.state).toBe('ready')
	expect(d.ctx.lastSeqNo).toBe(42n)
	expect(d.ctx.hasEverConnected).toBe(true)
	let session = d.emitted.find((o) => o.type === 'writer.session')
	expect(session).toMatchObject({ lastSeqNo: 42n, nextSeqNo: 43n })
	expect(d.dispatched).toContainEqual({ type: 'writer.pump' })
})

test('does not overwrite user seqNo with server value in manual mode', () => {
	let ctx = ctxWith({ seqNoMode: 'manual', lastSeqNo: 5n, highestUserSeqNo: 5n })
	let d = drive(
		'connecting',
		{ type: 'writer.stream.init_response', sessionId: 's1', lastSeqNo: 100n },
		ctx
	)

	expect(d.ctx.lastSeqNo).toBe(5n)
})

test('resets the retry counter on successful init', () => {
	let ctx = ctxWith({ attempts: 4 })
	let d = drive(
		'connecting',
		{ type: 'writer.stream.init_response', sessionId: 's1', lastSeqNo: 0n },
		ctx
	)

	expect(d.ctx.attempts).toBe(0)
})

// ── auto seqNo assigned at send time ─────────────────────────────────────────────

test('assigns auto seqNos sequentially at send time', () => {
	let ctx = ctxWith({ seqNoMode: 'auto', lastSeqNo: 10n, hasEverConnected: true })
	// three buffered auto messages, unnumbered
	drive('ready', { type: 'writer.write', message: msg(1) }, ctx)
	drive('ready', { type: 'writer.write', message: msg(2) }, ctx)
	drive('ready', { type: 'writer.write', message: msg(3) }, ctx)

	let d = drive('ready', { type: 'writer.pump' }, ctx)

	let batch = d.effects.find((e) => e.type === 'writer.effect.transport.send_batch')
	expect(
		batch &&
			batch.type === 'writer.effect.transport.send_batch' &&
			batch.messages.map((m) => m.seqNo)
	).toEqual([11n, 12n, 13n])
	expect(d.ctx.inflightLength).toBe(3)
	expect(d.ctx.bufferLength).toBe(0)
	expect(d.ctx.lastSeqNo).toBe(13n)
})

test('does not send when the inflight window is full', () => {
	let ctx = ctxWith({
		seqNoMode: 'auto',
		hasEverConnected: true,
		limits: { ...limits, maxInflightCount: 1 },
	})
	drive('ready', { type: 'writer.write', message: msg(1) }, ctx)
	drive('ready', { type: 'writer.write', message: msg(2) }, ctx)

	let first = drive('ready', { type: 'writer.pump' }, ctx)
	expect(first.ctx.inflightLength).toBe(1)

	let second = drive('ready', { type: 'writer.pump' }, ctx)
	expect(
		second.effects.find((e) => e.type === 'writer.effect.transport.send_batch')
	).toBeUndefined()
	expect(second.ctx.bufferLength).toBe(1)
})

// ── acknowledgements ─────────────────────────────────────────────────────────────

test('moves acknowledged messages out of the inflight window', () => {
	let ctx = ctxWith({ seqNoMode: 'auto', hasEverConnected: true, lastSeqNo: 0n })
	drive('ready', { type: 'writer.write', message: msg(1) }, ctx)
	drive('ready', { type: 'writer.write', message: msg(2) }, ctx)
	drive('ready', { type: 'writer.pump' }, ctx)

	let d = drive(
		'ready',
		{
			type: 'writer.stream.write_response',
			acks: [
				{ seqNo: 1n, status: 'written', offset: 0n },
				{ seqNo: 2n, status: 'written', offset: 1n },
			],
		},
		ctx
	)

	expect(d.ctx.inflightLength).toBe(0)
	let acks = d.emitted.find((o) => o.type === 'writer.acknowledgments')
	expect(acks && acks.type === 'writer.acknowledgments' && acks.acknowledgments.get(1n)).toBe(
		'written'
	)
})

// ── flush ────────────────────────────────────────────────────────────────────────

test('flushes immediately when nothing is pending', () => {
	let ctx = ctxWith({ hasEverConnected: true, lastSeqNo: 7n })
	let d = drive('ready', { type: 'writer.flush' }, ctx)

	let flushed = d.emitted.find((o) => o.type === 'writer.flushed')
	expect(flushed).toEqual({ type: 'writer.flushed', lastSeqNo: 7n })
})

test('emits flushed once the buffer drains after a flush request', () => {
	let ctx = ctxWith({ seqNoMode: 'auto', hasEverConnected: true })
	drive('ready', { type: 'writer.write', message: msg(1) }, ctx)
	drive('ready', { type: 'writer.pump' }, ctx)
	drive('ready', { type: 'writer.flush' }, ctx)
	expect(ctx.flushRequested).toBe(true)

	let d = drive(
		'ready',
		{ type: 'writer.stream.write_response', acks: [{ seqNo: 1n, status: 'written' }] },
		ctx
	)

	expect(d.emitted.find((o) => o.type === 'writer.flushed')).toBeDefined()
	expect(d.ctx.flushRequested).toBe(false)
})

// ── reconnect ────────────────────────────────────────────────────────────────────

test('reconnects on a retryable stream disconnect', () => {
	let ctx = ctxWith({ hasEverConnected: true })
	let d = drive(
		'ready',
		{
			type: 'writer.stream.disconnected',
			error: new YDBError(StatusIds_StatusCode.UNAVAILABLE, []),
		},
		ctx
	)

	expect(d.state).toBe('reconnecting')
	expect(effectTypes(d.effects)).toContain('writer.effect.timer.schedule')
})

test('fails terminally on a non-retryable stream disconnect', () => {
	let ctx = ctxWith({ hasEverConnected: true })
	let error = new YDBError(StatusIds_StatusCode.SCHEME_ERROR, [])
	let d = drive('ready', { type: 'writer.stream.disconnected', error }, ctx)

	expect(d.state).toBe('errored')
	expect(d.emitted.find((o) => o.type === 'writer.error')).toEqual({
		type: 'writer.error',
		error,
	})
})

test('reconnects without getLastSeqNo after backoff elapses', () => {
	let ctx = ctxWith({ hasEverConnected: true, retryScheduled: true })
	let d = drive('reconnecting', { type: 'writer.timer.retry_backoff' }, ctx)

	expect(d.state).toBe('connecting')
	let connect = d.effects.find((e) => e.type === 'writer.effect.transport.connect')
	expect(connect).toEqual({ type: 'writer.effect.transport.connect', getLastSeqNo: false })
	expect(d.ctx.attempts).toBe(1)
})

test('fails terminally when the recovery window expires', () => {
	let ctx = ctxWith({ hasEverConnected: true })
	let d = drive('reconnecting', { type: 'writer.timer.recovery_window' }, ctx)

	expect(d.state).toBe('errored')
})

test('fails terminally when the recovery window expires during a connect attempt', () => {
	// The window can elapse while retrying in `connecting`, not just `reconnecting`.
	let ctx = ctxWith({ hasEverConnected: true })
	let d = drive('connecting', { type: 'writer.timer.recovery_window' }, ctx)

	expect(d.state).toBe('errored')
})

test('resends unacked inflight and drops server-acked on reconnect init', () => {
	// two messages sent (seqNo 1,2); server persisted 1 only.
	let ctx = ctxWith({ seqNoMode: 'auto', hasEverConnected: true, lastSeqNo: 0n })
	drive('ready', { type: 'writer.write', message: msg(1) }, ctx)
	drive('ready', { type: 'writer.write', message: msg(2) }, ctx)
	drive('ready', { type: 'writer.pump' }, ctx)
	expect(ctx.inflightLength).toBe(2)

	let d = drive(
		'connecting',
		{ type: 'writer.stream.init_response', sessionId: 's2', lastSeqNo: 1n },
		ctx
	)

	// seqNo 1 dropped (already written), seqNo 2 rewound into the buffer for resend.
	expect(d.ctx.inflightLength).toBe(0)
	expect(d.ctx.bufferLength).toBe(1)
	let recovered = d.emitted.find((o) => o.type === 'writer.acknowledgments')
	expect(
		recovered &&
			recovered.type === 'writer.acknowledgments' &&
			recovered.acknowledgments.get(1n)
	).toBe('skipped')
})

// ── close / destroy ──────────────────────────────────────────────────────────────

test('closes immediately when nothing is pending', () => {
	let ctx = ctxWith({ hasEverConnected: true })
	let d = drive('ready', { type: 'writer.close' }, ctx)

	expect(d.state).toBe('closed')
	expect(d.emitted.find((o) => o.type === 'writer.closed')).toBeDefined()
	expect(effectTypes(d.effects)).toContain('writer.effect.transport.close')
})

test('drains before closing when messages are pending', () => {
	let ctx = ctxWith({ seqNoMode: 'auto', hasEverConnected: true })
	drive('ready', { type: 'writer.write', message: msg(1) }, ctx)
	drive('ready', { type: 'writer.pump' }, ctx)

	let d = drive('ready', { type: 'writer.close' }, ctx)
	expect(d.state).toBe('closing')

	let done = drive(
		'closing',
		{ type: 'writer.stream.write_response', acks: [{ seqNo: 1n, status: 'written' }] },
		d.ctx
	)
	expect(done.state).toBe('closed')
})

test('fails when the graceful timeout fires with undelivered messages', () => {
	let ctx = ctxWith({
		seqNoMode: 'auto',
		hasEverConnected: true,
		bufferLength: 1,
		messages: [msg(1)],
	})
	let d = drive('closing', { type: 'writer.timer.graceful_timeout' }, ctx)

	// Undelivered messages on a forced shutdown is a flush failure, not a clean close.
	expect(d.state).toBe('errored')
	expect(d.emitted.find((o) => o.type === 'writer.error')).toBeDefined()
})

test('closes cleanly when the graceful timeout fires with nothing pending', () => {
	let ctx = ctxWith({ hasEverConnected: true })
	let d = drive('closing', { type: 'writer.timer.graceful_timeout' }, ctx)

	expect(d.state).toBe('closed')
})

test('destroys from any state, tearing down the transport', () => {
	let ctx = ctxWith({ hasEverConnected: true })
	let d = drive('ready', { type: 'writer.destroy', reason: new Error('boom') }, ctx)

	expect(d.state).toBe('closed')
	expect(effectTypes(d.effects)).toContain('writer.effect.transport.close')
	expect(effectTypes(d.effects)).toContain('writer.effect.finalize')
})

test('ignores events once closed', () => {
	let ctx = ctxWith()
	let d = drive('closed', { type: 'writer.write', message: msg(1) }, ctx)

	expect(d.state).toBe('closed')
	expect(d.ctx.bufferLength).toBe(0)
})

// ── resource / memory ────────────────────────────────────────────────────────────

test('reclaims the message array as acknowledgments accumulate', () => {
	let ctx = ctxWith({ seqNoMode: 'auto', hasEverConnected: true })

	// Write, send and acknowledge many messages one at a time. Garbage compaction
	// must keep the backing array bounded — a leak would grow it without limit.
	for (let i = 0; i < 5000; i++) {
		drive('ready', { type: 'writer.write', message: msg(1) }, ctx)
		drive('ready', { type: 'writer.pump' }, ctx)
		drive(
			'ready',
			{
				type: 'writer.stream.write_response',
				acks: [{ seqNo: ctx.lastSeqNo, status: 'written' }],
			},
			ctx
		)
	}

	expect(ctx.messages.length).toBeLessThan(16)
	expect(ctx.garbageSize).toBe(0n)
})

test('releases the message buffer on destroy', () => {
	let ctx = ctxWith({ seqNoMode: 'auto', hasEverConnected: true })
	drive('ready', { type: 'writer.write', message: msg(1) }, ctx)
	drive('ready', { type: 'writer.write', message: msg(2) }, ctx)
	drive('ready', { type: 'writer.pump' }, ctx)

	let d = drive('ready', { type: 'writer.destroy', reason: new Error('x') }, ctx)

	expect(d.state).toBe('closed')
	expect(d.ctx.messages).toHaveLength(0)
	expect(d.ctx.bufferLength).toBe(0)
	expect(d.ctx.inflightLength).toBe(0)
	expect(d.ctx.bufferSize).toBe(0n)
	expect(d.ctx.inflightSize).toBe(0n)
})

test('releases the message buffer on a terminal error', () => {
	let ctx = ctxWith({
		seqNoMode: 'auto',
		hasEverConnected: true,
		messages: [msg(1)],
		bufferLength: 1,
	})
	let d = drive('reconnecting', { type: 'writer.timer.recovery_window' }, ctx)

	expect(d.state).toBe('errored')
	expect(d.ctx.messages).toHaveLength(0)
})
