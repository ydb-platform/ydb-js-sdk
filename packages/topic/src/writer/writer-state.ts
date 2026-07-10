import { create } from '@bufbuild/protobuf'
import { timestampFromDate } from '@bufbuild/protobuf/wkt'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import {
	type StreamWriteMessage_WriteRequest_MessageData,
	StreamWriteMessage_WriteRequest_MessageDataSchema,
} from '@ydbjs/api/topic'
import { YDBError } from '@ydbjs/error'
import type { TransitionResult, TransitionRuntime } from '@ydbjs/fsm'
import { isRetryableError, isRetryableStreamError } from '@ydbjs/retry'

import type { AckStatus, WriteAck } from './types.js'

// The pure half of the writer: states, context, and a synchronous transition
// with no I/O. Everything here mutates `ctx` in place and returns the next
// state + a list of effects for the runtime to execute — see writer-runtime.ts
// for the I/O side. The buffer is a sliding window (see WriterCtx) and byte
// budgeting lives in the facade, so the transition only counts messages.

// Hard service limits (bytes).
export let MAX_BATCH_BYTES = 48n * 1024n * 1024n // one WriteRequest frame stays under 48MiB
export let MAX_PAYLOAD_BYTES = 48n * 1024n * 1024n // single message payload cap

// ── State / context ─────────────────────────────────────────────────────────────

// `closed` = graceful/destroyed terminal; `errored` = fatal terminal. Both are final.
export type WriterState =
	| 'idle'
	| 'connecting'
	| 'ready'
	| 'reconnecting'
	| 'closing'
	| 'closed'
	| 'errored'

// A message living in the sliding window before/while it is on the wire.
// In auto mode `seqNo` stays 0n until the message is actually sent (assigned in `pump`);
// in manual mode it is set at enqueue. This is why buffered auto messages never
// need renumbering on reconnect — they simply have no number yet.
export type BufferedMessage = {
	// Already compressed with the writer's codec (identity for RAW).
	data: Uint8Array
	// Original (pre-compression) payload size reported to the server.
	uncompressedSize: bigint
	seqNo: bigint
	createdAt: Date
	metadataItems?: Record<string, Uint8Array>
}

export type WriterLimits = {
	maxInflightCount: number
	maxBatchBytes: bigint
}

// Pure logical context — mutated synchronously inside the transition only.
// The single message array is a sliding window: [garbage | inflight | buffer].
//   garbage   = [0, inflightStart)              (acked, awaiting compaction)
//   inflight  = [inflightStart, bufferStart)    (sent, awaiting ack)
//   buffer    = [bufferStart, messages.length)  (not yet sent)
export type WriterCtx = {
	// seqNo bookkeeping
	seqNoMode: 'auto' | 'manual' | null
	lastSeqNo: bigint
	hasEverConnected: boolean
	sessionId: string

	// reconnect bookkeeping
	attempts: number
	lastError: unknown
	retryScheduled: boolean
	startTimeoutScheduled: boolean
	// When set, a SCHEME_ERROR (e.g. the topic does not exist yet) is retried instead
	// of being fatal — the writer waits until the topic is created.
	retryOnSchemeError: boolean
	// Terminal reconnect deadline (ms). Infinity = unbounded (reconnect forever); the
	// transition owns whether to arm the `recovery_window` timer based on this.
	recoveryWindowMs: number

	flushRequested: boolean

	// sliding-window buffer (see the diagram above)
	messages: BufferedMessage[]
	bufferStart: number
	bufferLength: number
	inflightStart: number
	inflightLength: number

	limits: WriterLimits
}

export type WriterEvent =
	// user (dispatched by the facade)
	| { type: 'writer.start' }
	| { type: 'writer.write'; message: BufferedMessage }
	| { type: 'writer.flush' }
	| { type: 'writer.close' }
	| { type: 'writer.destroy'; reason?: unknown }
	// internal self-dispatch — fsm has no `always`/`after`, so the send loop is an explicit event
	| { type: 'writer.pump' }
	// transport → writer (ingested from the transport FSM output)
	| {
			type: 'writer.stream.init_response'
			sessionId: string
			lastSeqNo: bigint
			partitionId?: bigint
	  }
	| { type: 'writer.stream.write_response'; acks: WriteAck[] }
	| { type: 'writer.stream.token_response' }
	| { type: 'writer.stream.disconnected'; error?: unknown }
	// timers
	| { type: 'writer.timer.start_timeout' }
	| { type: 'writer.timer.retry_backoff' }
	| { type: 'writer.timer.recovery_window' }
	| { type: 'writer.timer.flush_tick' }
	| { type: 'writer.timer.update_token' }
	| { type: 'writer.timer.graceful_timeout' }

export type TimerName =
	| 'start_timeout'
	| 'retry_backoff'
	| 'recovery_window'
	| 'flush_tick'
	| 'update_token'
	| 'graceful_timeout'

export type WriterEffect =
	| { type: 'writer.effect.transport.connect'; getLastSeqNo: boolean }
	| {
			type: 'writer.effect.transport.send_batch'
			messages: StreamWriteMessage_WriteRequest_MessageData[]
	  }
	| { type: 'writer.effect.transport.send_update_token' }
	| { type: 'writer.effect.transport.close' }
	| { type: 'writer.effect.timer.schedule'; which: TimerName }
	| { type: 'writer.effect.timer.clear'; which: TimerName }
	| { type: 'writer.effect.finalize'; reason: unknown }

export type WriterOutput =
	| { type: 'writer.session'; sessionId: string; lastSeqNo: bigint; nextSeqNo: bigint }
	// `freedBytes` = compressed bytes that left the window with this ack batch, so
	// the facade can decrement its byte budget without re-tracking message sizes.
	| {
			type: 'writer.acknowledgments'
			acknowledgments: Map<bigint, AckStatus>
			freedBytes: bigint
	  }
	| { type: 'writer.flushed'; lastSeqNo: bigint }
	| { type: 'writer.reconnecting'; attempt: number; error?: unknown }
	| { type: 'writer.error'; error: unknown }
	| { type: 'writer.closed'; reason?: unknown }

type WriterRuntime = TransitionRuntime<WriterState, WriterEvent, WriterOutput>

// ── Helpers ─────────────────────────────────────────────────────────────────────

export let createWriterCtx = function createWriterCtx(
	limits: WriterLimits,
	retryOnSchemeError = false,
	recoveryWindowMs = Infinity
): WriterCtx {
	return {
		seqNoMode: null,
		lastSeqNo: 0n,
		hasEverConnected: false,
		sessionId: '',

		attempts: 0,
		lastError: undefined,
		retryScheduled: false,
		startTimeoutScheduled: false,
		retryOnSchemeError,
		recoveryWindowMs,

		flushRequested: false,

		messages: [],
		bufferStart: 0,
		bufferLength: 0,
		inflightStart: 0,
		inflightLength: 0,

		limits,
	}
}

// A stream error is retryable when the writer should reconnect transparently.
// Topic writes are idempotent (dedup by producerId+seqNo), so we use the
// idempotent classification — unlike the plain stream classifier, this retries
// the "conditionally" YDB statuses (SESSION_EXPIRED, UNDETERMINED, TIMEOUT).
// A clean stream end with no error object is also retryable (server-side reconnect).
// SCHEME_ERROR is fatal unless `retryOnSchemeError` is set (wait for topic creation).
export let isRetryableWriterError = function isRetryableWriterError(
	error: unknown,
	retryOnSchemeError = false
): boolean {
	if (error === undefined || error === null) {
		return true
	}

	if (isPayloadTooLargeError(error)) {
		return false
	}

	if (
		retryOnSchemeError &&
		error instanceof YDBError &&
		error.code === StatusIds_StatusCode.SCHEME_ERROR
	) {
		return true
	}

	return isRetryableStreamError(error) || isRetryableError(error, true)
}

// The server rejects an over-sized frame with a size complaint; retrying it would
// loop forever, so it must be treated as fatal (Go demotes this case explicitly).
let isPayloadTooLargeError = function isPayloadTooLargeError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false
	}

	return /larger than|exceeds|too large|message size/i.test(error.message)
}

let allDrained = function allDrained(ctx: WriterCtx): boolean {
	return ctx.bufferLength === 0 && ctx.inflightLength === 0
}

// Resolve a pending flush the moment the window is empty. Every path that can
// drain the buffer (a write_response ack, or a reconnect whose init dedups all
// in-flight messages) must call this — otherwise a flush that drains via the
// dedup path never emits writer.flushed and the caller hangs forever.
let resolveFlushIfDrained = function resolveFlushIfDrained(
	ctx: WriterCtx,
	runtime: WriterRuntime
): void {
	if (ctx.flushRequested && allDrained(ctx)) {
		ctx.flushRequested = false
		runtime.emit({ type: 'writer.flushed', lastSeqNo: ctx.lastSeqNo })
	}
}

// Record a flush request. Honored in every live state — a flush issued while the
// writer is still connecting must resolve once messages drain after init, not be
// dropped. Resolves immediately when there is nothing pending.
let requestFlush = function requestFlush(ctx: WriterCtx, runtime: WriterRuntime): void {
	ctx.flushRequested = true
	if (allDrained(ctx)) {
		resolveFlushIfDrained(ctx, runtime)
		return
	}
	runtime.dispatch({ type: 'writer.pump' })
}

// Build the on-wire MessageData for one buffered message. Pure — no I/O.
let toMessageData = function toMessageData(
	message: BufferedMessage
): StreamWriteMessage_WriteRequest_MessageData {
	let metadataItems = message.metadataItems
		? Object.entries(message.metadataItems).map(([key, value]) => ({ key, value }))
		: []

	return create(StreamWriteMessage_WriteRequest_MessageDataSchema, {
		data: message.data,
		seqNo: message.seqNo,
		createdAt: timestampFromDate(message.createdAt),
		metadataItems,
		uncompressedSize: message.uncompressedSize,
	})
}

// Form the next batch: take from the front of the buffer up to the inflight and
// batch-byte limits, assigning auto seqNos as we go. Mutates the window in place
// (buffer → inflight) and returns the on-wire messages. Synchronous by design.
let formBatch = function formBatch(ctx: WriterCtx): StreamWriteMessage_WriteRequest_MessageData[] {
	let batch: StreamWriteMessage_WriteRequest_MessageData[] = []
	let batchBytes = 0n
	let end = ctx.bufferStart + ctx.bufferLength

	for (let i = ctx.bufferStart; i < end; i++) {
		let message = ctx.messages[i]!
		let size = BigInt(message.data.length)

		if (batch.length > 0 && batchBytes + size > ctx.limits.maxBatchBytes) {
			break
		}

		if (ctx.inflightLength + batch.length >= ctx.limits.maxInflightCount) {
			break
		}

		// Auto mode: the seqNo is assigned now, at send time, from the high-water mark.
		if (message.seqNo === 0n) {
			ctx.lastSeqNo += 1n
			message.seqNo = ctx.lastSeqNo
		}

		batch.push(toMessageData(message))
		batchBytes += size
	}

	let count = batch.length
	ctx.bufferStart += count
	ctx.bufferLength -= count
	ctx.inflightLength += count

	return batch
}

// Apply a server init: recover the seqNo high-water mark once (auto numbering),
// then drop any server-persisted in-flight messages and rewind the rest for resend.
//
// The dedup runs on EVERY init, including reconnects: YDB reports last_seq_no even
// when get_last_seq_no is false (proven in tests/writer-protocol.test.ts), so we
// skip resending messages the server already has — like the Java SDK. We only
// request get_last_seq_no on the first connect (like Go) to avoid its cost. If a
// reconnect ever reported 0, dropAckedAndRewind drops nothing and we resend
// everything; the server dedups by producerId+seqNo — correct either way, just
// less efficient. So this is an optimization, not a correctness dependency.
let applyInit = function applyInit(
	ctx: WriterCtx,
	sessionId: string,
	serverLastSeqNo: bigint,
	runtime: WriterRuntime
): void {
	ctx.sessionId = sessionId

	if (!ctx.hasEverConnected) {
		// Trust the server's high-water mark exactly once. Manual mode keeps the
		// user's numbers; auto mode continues above the recovered value.
		if (ctx.seqNoMode !== 'manual' && serverLastSeqNo > ctx.lastSeqNo) {
			ctx.lastSeqNo = serverLastSeqNo
		}
		ctx.hasEverConnected = true
	}

	let { recovered, freedBytes } = dropAckedAndRewind(ctx, serverLastSeqNo)
	if (recovered.size > 0) {
		runtime.emit({ type: 'writer.acknowledgments', acknowledgments: recovered, freedBytes })
	}

	runtime.emit({
		type: 'writer.session',
		sessionId,
		lastSeqNo: ctx.lastSeqNo,
		nextSeqNo: ctx.lastSeqNo + 1n,
	})
}

// Drop in-flight messages the server already persisted (seqNo <= serverLastSeqNo),
// surfacing them as `skipped` (deduplicated), and move the remaining unacked
// in-flight messages back to the front of the buffer to be resent in order.
// Only scans the in-flight range; buffered (unsent, unnumbered) messages are untouched.
let dropAckedAndRewind = function dropAckedAndRewind(
	ctx: WriterCtx,
	serverLastSeqNo: bigint
): { recovered: Map<bigint, AckStatus>; freedBytes: bigint } {
	let recovered = new Map<bigint, AckStatus>()
	let inflightEnd = ctx.bufferStart
	let freedBytes = 0n
	let firstUnacked = inflightEnd

	for (let i = ctx.inflightStart; i < inflightEnd; i++) {
		let message = ctx.messages[i]!

		if (message.seqNo !== 0n && message.seqNo <= serverLastSeqNo) {
			freedBytes += BigInt(message.data.length)
			recovered.set(message.seqNo, 'skipped')
			continue
		}

		if (firstUnacked === inflightEnd) {
			firstUnacked = i
		}
	}

	ctx.bufferStart = firstUnacked
	ctx.bufferLength = ctx.messages.length - firstUnacked
	ctx.inflightStart = firstUnacked
	ctx.inflightLength = 0

	return { recovered, freedBytes }
}

// Move server-acknowledged messages out of the in-flight window into garbage.
// The server acks the in-flight prefix in order, so we walk from the head and
// stop at the first unacked message. We report only the messages actually removed
// from the window, so the emitted acks and the freed-byte total can never drift
// from the window even if a stream ever delivered a non-prefix ack set.
let acknowledge = function acknowledge(
	ctx: WriterCtx,
	acks: WriteAck[]
): { acknowledgments: Map<bigint, AckStatus>; freedBytes: bigint } {
	let status = new Map<bigint, AckStatus>()
	for (let ack of acks) {
		status.set(ack.seqNo, ack.status)
	}

	let acknowledgments = new Map<bigint, AckStatus>()
	let freedBytes = 0n
	let inflightEnd = ctx.bufferStart
	while (ctx.inflightStart < inflightEnd) {
		let message = ctx.messages[ctx.inflightStart]!
		let messageStatus = status.get(message.seqNo)
		if (messageStatus === undefined) {
			break
		}

		acknowledgments.set(message.seqNo, messageStatus)
		freedBytes += BigInt(message.data.length)
		ctx.inflightStart += 1
		ctx.inflightLength -= 1
	}

	compactGarbage(ctx)

	return { acknowledgments, freedBytes }
}

// Reclaim the garbage prefix by splicing it out and rebasing the window pointers.
let compactGarbage = function compactGarbage(ctx: WriterCtx): void {
	let garbageLength = ctx.inflightStart
	if (garbageLength === 0) {
		return
	}

	ctx.messages.splice(0, garbageLength)
	ctx.inflightStart = 0
	ctx.bufferStart -= garbageLength
}

// Reset all reconnect scheduling flags.
let clearScheduling = function clearScheduling(ctx: WriterCtx): void {
	ctx.retryScheduled = false
	ctx.startTimeoutScheduled = false
}

let clearAllTimersEffects: WriterEffect[] = [
	{ type: 'writer.effect.timer.clear', which: 'start_timeout' },
	{ type: 'writer.effect.timer.clear', which: 'retry_backoff' },
	{ type: 'writer.effect.timer.clear', which: 'recovery_window' },
	{ type: 'writer.effect.timer.clear', which: 'flush_tick' },
	{ type: 'writer.effect.timer.clear', which: 'update_token' },
]

// Terminal transition into `closed` or `errored`: emit the lifecycle output,
// tear the transport down, clear timers and finalize. Reused from many states.
let terminate = function terminate(
	ctx: WriterCtx,
	state: 'closed' | 'errored',
	reason: unknown,
	runtime: WriterRuntime
): TransitionResult<WriterState, WriterEffect> {
	clearScheduling(ctx)

	if (state === 'errored') {
		ctx.lastError = reason
		runtime.emit({ type: 'writer.error', error: reason })
	}
	runtime.emit({ type: 'writer.closed', reason })

	// Drop any still-buffered/in-flight messages so their payloads can be GC'd —
	// on a terminal stop they will never be sent or acknowledged.
	releaseBuffer(ctx)

	return {
		state,
		effects: [
			{ type: 'writer.effect.transport.close' },
			...clearAllTimersEffects,
			{ type: 'writer.effect.finalize', reason },
		],
	}
}

// Free the message window. Called on terminal stop to release payload memory.
let releaseBuffer = function releaseBuffer(ctx: WriterCtx): void {
	ctx.messages = []
	ctx.bufferStart = 0
	ctx.bufferLength = 0
	ctx.inflightStart = 0
	ctx.inflightLength = 0
}

// Append a message to the buffer. Total by design — seqNo-mode validation
// (which must throw synchronously to the caller) lives in the facade, so the
// transition never throws and can never accidentally destroy the machine.
// A non-zero seqNo means the facade already validated a manual message; a zero
// seqNo is an auto message that gets its number at send time (see formBatch).
let enqueue = function enqueue(ctx: WriterCtx, message: BufferedMessage): void {
	let providedSeqNo = message.seqNo !== 0n

	if (ctx.seqNoMode === null) {
		ctx.seqNoMode = providedSeqNo ? 'manual' : 'auto'
	}

	// Manual mode: lastSeqNo tracks the user's high-water mark for resend/recovery.
	if (providedSeqNo && message.seqNo > ctx.lastSeqNo) {
		ctx.lastSeqNo = message.seqNo
	}

	ctx.messages.push(message)
	ctx.bufferLength += 1
}

// ── Transition ──────────────────────────────────────────────────────────────────

export let writerTransition = function writerTransition(
	ctx: WriterCtx,
	event: WriterEvent,
	runtime: WriterRuntime
): TransitionResult<WriterState, WriterEffect> | void {
	let state = runtime.state

	// Global: hard destroy from any non-terminal state.
	if (state !== 'closed' && state !== 'errored' && event.type === 'writer.destroy') {
		return terminate(ctx, 'closed', event.reason ?? new Error('Writer destroyed'), runtime)
	}

	switch (state) {
		case 'idle': {
			if (event.type === 'writer.start') {
				ctx.startTimeoutScheduled = true
				return {
					state: 'connecting',
					effects: [
						{ type: 'writer.effect.transport.connect', getLastSeqNo: true },
						{ type: 'writer.effect.timer.schedule', which: 'start_timeout' },
					],
				}
			}

			if (event.type === 'writer.write') {
				enqueue(ctx, event.message)
				return
			}

			if (event.type === 'writer.close') {
				return terminate(ctx, 'closed', new Error('Writer closed before start'), runtime)
			}

			return
		}

		case 'connecting': {
			if (event.type === 'writer.write') {
				enqueue(ctx, event.message)
				return
			}

			if (event.type === 'writer.flush') {
				requestFlush(ctx, runtime)
				return
			}

			if (event.type === 'writer.stream.init_response') {
				return toReady(ctx, event, runtime)
			}

			if (
				event.type === 'writer.stream.disconnected' ||
				event.type === 'writer.timer.start_timeout'
			) {
				let error = event.type === 'writer.stream.disconnected' ? event.error : undefined
				if (
					event.type === 'writer.stream.disconnected' &&
					!isRetryableWriterError(error, ctx.retryOnSchemeError)
				) {
					return terminate(ctx, 'errored', error, runtime)
				}
				return toReconnecting(ctx, error, runtime)
			}

			// The recovery window is armed while reconnecting and can elapse during a
			// connect attempt — without this the terminal bound would never fire.
			if (event.type === 'writer.timer.recovery_window') {
				return terminate(
					ctx,
					'errored',
					ctx.lastError ?? new Error('Recovery window expired'),
					runtime
				)
			}

			if (event.type === 'writer.close') {
				return toClosing(ctx, runtime)
			}

			return
		}

		case 'ready': {
			if (event.type === 'writer.write') {
				enqueue(ctx, event.message)
				runtime.dispatch({ type: 'writer.pump' })
				return
			}

			if (event.type === 'writer.pump' || event.type === 'writer.timer.flush_tick') {
				return pump(ctx, runtime)
			}

			if (event.type === 'writer.stream.write_response') {
				let { acknowledgments, freedBytes } = acknowledge(ctx, event.acks)
				if (acknowledgments.size > 0) {
					runtime.emit({ type: 'writer.acknowledgments', acknowledgments, freedBytes })
				}
				resolveFlushIfDrained(ctx, runtime)
				runtime.dispatch({ type: 'writer.pump' })
				return
			}

			if (event.type === 'writer.flush') {
				requestFlush(ctx, runtime)
				return
			}

			if (event.type === 'writer.timer.update_token') {
				return { effects: [{ type: 'writer.effect.transport.send_update_token' }] }
			}

			if (event.type === 'writer.stream.token_response') {
				return
			}

			if (event.type === 'writer.stream.disconnected') {
				if (!isRetryableWriterError(event.error, ctx.retryOnSchemeError)) {
					return terminate(ctx, 'errored', event.error, runtime)
				}
				return toReconnecting(ctx, event.error, runtime)
			}

			if (event.type === 'writer.close') {
				return toClosing(ctx, runtime)
			}

			return
		}

		case 'reconnecting': {
			if (event.type === 'writer.write') {
				enqueue(ctx, event.message)
				return
			}

			if (event.type === 'writer.flush') {
				requestFlush(ctx, runtime)
				return
			}

			// A connect attempt whose init lands here (start_timeout fired just before
			// the init was dequeued, so the stream is still open) is a live session —
			// honor it rather than dropping it and forcing a wasted reconnect.
			if (event.type === 'writer.stream.init_response') {
				return toReady(ctx, event, runtime)
			}

			if (event.type === 'writer.timer.retry_backoff') {
				ctx.retryScheduled = false
				ctx.attempts += 1
				ctx.startTimeoutScheduled = true
				return {
					state: 'connecting',
					effects: [
						// Re-request last_seq_no only if it was never recovered — otherwise a
						// retry that races the very first connect would resume at seqNo 0 and
						// silently collide with already-persisted messages.
						{
							type: 'writer.effect.transport.connect',
							getLastSeqNo: !ctx.hasEverConnected,
						},
						{ type: 'writer.effect.timer.schedule', which: 'start_timeout' },
					],
				}
			}

			if (event.type === 'writer.timer.recovery_window') {
				return terminate(
					ctx,
					'errored',
					ctx.lastError ?? new Error('Recovery window expired'),
					runtime
				)
			}

			if (event.type === 'writer.stream.disconnected') {
				// Already backing off — record the reason but stay put.
				if (event.error !== undefined) {
					ctx.lastError = event.error
				}
				return
			}

			if (event.type === 'writer.close') {
				return toClosing(ctx, runtime)
			}

			return
		}

		case 'closing': {
			if (event.type === 'writer.stream.write_response') {
				acknowledge(ctx, event.acks)
				if (allDrained(ctx)) {
					return terminate(ctx, 'closed', new Error('Writer closed'), runtime)
				}
				runtime.dispatch({ type: 'writer.pump' })
				return
			}

			if (event.type === 'writer.pump' || event.type === 'writer.timer.flush_tick') {
				return pump(ctx, runtime)
			}

			// A reconnect completed mid-close — recover and keep draining.
			if (event.type === 'writer.stream.init_response') {
				applyInit(ctx, event.sessionId, event.lastSeqNo, runtime)
				if (allDrained(ctx)) {
					return terminate(ctx, 'closed', new Error('Writer closed'), runtime)
				}
				runtime.dispatch({ type: 'writer.pump' })
				return { effects: [{ type: 'writer.effect.timer.clear', which: 'start_timeout' }] }
			}

			if (event.type === 'writer.timer.retry_backoff') {
				ctx.retryScheduled = false
				ctx.startTimeoutScheduled = true
				return {
					effects: [
						{
							type: 'writer.effect.transport.connect',
							getLastSeqNo: !ctx.hasEverConnected,
						},
						{ type: 'writer.effect.timer.schedule', which: 'start_timeout' },
					],
				}
			}

			if (event.type === 'writer.timer.graceful_timeout') {
				// Forced shutdown with messages still pending is a failure to flush —
				// surface it (as `errored`) so close() rejects instead of silently
				// dropping undelivered writes (critical for tx commit integrity).
				if (!allDrained(ctx)) {
					return terminate(
						ctx,
						'errored',
						new Error('Graceful shutdown timed out with undelivered messages'),
						runtime
					)
				}
				return terminate(ctx, 'closed', new Error('Writer closed'), runtime)
			}

			if (
				event.type === 'writer.stream.disconnected' ||
				event.type === 'writer.timer.start_timeout'
			) {
				let error = event.type === 'writer.stream.disconnected' ? event.error : undefined
				// Retry the drain over a fresh stream (bounded by graceful_timeout);
				// give up terminally on a fatal error.
				if (!isRetryableWriterError(error, ctx.retryOnSchemeError)) {
					return terminate(ctx, 'errored', error, runtime)
				}
				ctx.retryScheduled = true
				return {
					effects: [
						{ type: 'writer.effect.timer.clear', which: 'start_timeout' },
						{ type: 'writer.effect.timer.schedule', which: 'retry_backoff' },
					],
				}
			}

			// New writes are rejected once closing (facade throws before dispatch),
			// so ignore anything else.
			return
		}

		case 'closed':
		case 'errored':
			return
	}
}

// ready + (write/pump/flush_tick): drain buffer → inflight, one batch per event.
let pump = function pump(
	ctx: WriterCtx,
	runtime: WriterRuntime
): TransitionResult<WriterState, WriterEffect> | void {
	if (ctx.bufferLength === 0 || ctx.inflightLength >= ctx.limits.maxInflightCount) {
		return
	}

	let messages = formBatch(ctx)
	if (messages.length === 0) {
		return
	}

	// More to send and room to send it — keep pumping on the next tick.
	if (ctx.bufferLength > 0 && ctx.inflightLength < ctx.limits.maxInflightCount) {
		runtime.dispatch({ type: 'writer.pump' })
	}

	return { effects: [{ type: 'writer.effect.transport.send_batch', messages }] }
}

// Enter `ready` on a successful init — from `connecting`, or from `reconnecting`
// when a slow init lands after start_timeout already moved us there. Recover the
// seqNo state, resolve any pending flush the recovery just drained, and resume.
let toReady = function toReady(
	ctx: WriterCtx,
	event: Extract<WriterEvent, { type: 'writer.stream.init_response' }>,
	runtime: WriterRuntime
): TransitionResult<WriterState, WriterEffect> {
	ctx.attempts = 0
	ctx.startTimeoutScheduled = false
	clearScheduling(ctx)
	applyInit(ctx, event.sessionId, event.lastSeqNo, runtime)
	resolveFlushIfDrained(ctx, runtime)

	runtime.dispatch({ type: 'writer.pump' })

	return {
		state: 'ready',
		effects: [
			{ type: 'writer.effect.timer.clear', which: 'start_timeout' },
			{ type: 'writer.effect.timer.clear', which: 'retry_backoff' },
			{ type: 'writer.effect.timer.clear', which: 'recovery_window' },
			{ type: 'writer.effect.timer.schedule', which: 'flush_tick' },
			{ type: 'writer.effect.timer.schedule', which: 'update_token' },
		],
	}
}

let toReconnecting = function toReconnecting(
	ctx: WriterCtx,
	error: unknown,
	runtime: WriterRuntime
): TransitionResult<WriterState, WriterEffect> {
	ctx.retryScheduled = true
	ctx.startTimeoutScheduled = false
	if (error !== undefined) {
		ctx.lastError = error
	}
	runtime.emit({
		type: 'writer.reconnecting',
		attempt: ctx.attempts,
		...(error !== undefined && { error }),
	})
	// No transport.close here — the transport already closed its own stream on
	// disconnect, and the reconnect happens via transport.connect (which reopens).
	let effects: WriterEffect[] = [
		{ type: 'writer.effect.timer.clear', which: 'start_timeout' },
		{ type: 'writer.effect.timer.clear', which: 'flush_tick' },
		{ type: 'writer.effect.timer.clear', which: 'update_token' },
		{ type: 'writer.effect.timer.schedule', which: 'retry_backoff' },
	]
	// Arm the terminal deadline only when recovery is bounded. Unbounded (Infinity)
	// means reconnect forever — the transition owns that policy so the emitted effects
	// reflect it (model-testable), instead of the runtime silently dropping the timer.
	if (Number.isFinite(ctx.recoveryWindowMs)) {
		effects.push({ type: 'writer.effect.timer.schedule', which: 'recovery_window' })
	}
	return { state: 'reconnecting', effects }
}

// Enter graceful shutdown. If nothing is pending, finalize now; otherwise drain
// the buffer (over the live stream, or over a reconnect if one is already
// scheduled) bounded by the graceful-shutdown timeout. Retry/recovery timers are
// intentionally preserved so a close issued while reconnecting still flushes.
let toClosing = function toClosing(
	ctx: WriterCtx,
	runtime: WriterRuntime
): TransitionResult<WriterState, WriterEffect> {
	ctx.startTimeoutScheduled = false

	if (allDrained(ctx)) {
		return terminate(ctx, 'closed', new Error('Writer closed'), runtime)
	}

	runtime.dispatch({ type: 'writer.pump' })

	return {
		state: 'closing',
		effects: [
			// Closing may be entered while reconnecting — cancel a stale recovery_window
			// so it cannot cut the graceful drain short (close is bounded by
			// graceful_timeout, like the reader). start_timeout / retry_backoff are left
			// armed: the closing state uses them to keep reconnecting to finish the drain.
			{ type: 'writer.effect.timer.clear', which: 'recovery_window' },
			{ type: 'writer.effect.timer.clear', which: 'flush_tick' },
			{ type: 'writer.effect.timer.clear', which: 'update_token' },
			{ type: 'writer.effect.timer.schedule', which: 'graceful_timeout' },
		],
	}
}
