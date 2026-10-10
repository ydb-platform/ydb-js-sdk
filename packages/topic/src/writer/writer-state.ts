import { create } from '@bufbuild/protobuf'
import { timestampFromDate } from '@bufbuild/protobuf/wkt'
import {
	type StreamWriteMessage_WriteRequest_MessageData,
	StreamWriteMessage_WriteRequest_MessageDataSchema,
} from '@ydbjs/api/topic'
import { loggers } from '@ydbjs/debug'
import type { TransitionResult, TransitionRuntime } from '@ydbjs/fsm'

import { isRetryableTopicError } from '../retry.js'

import type { AckStatus, WriteAck } from './types.js'

// The pure half of the writer: states, context, and a synchronous transition
// with no I/O. Everything here mutates `ctx` in place and returns the next
// state + a list of effects for the runtime to execute — see writer-runtime.ts
// for the I/O side. The buffer is a sliding window (see WriterCtx) and byte
// admission budgeting lives in the facade; the transition owns batching.
//
// The full transition map (table + diagram) lives in packages/topic/ARCHITECTURE.md —
// update it in the same commit when you change this dispatch.

let dbg = loggers.topic.extend('writer')

// Payload limits leave headroom for protocol framing.
export const MAX_BATCH_BYTES = 48n * 1024n * 1024n // compressed-payload batch target
export const MAX_PAYLOAD_BYTES = 48n * 1024n * 1024n // single uncompressed payload cap

// ── State / context ─────────────────────────────────────────────────────────────

// `closed` = graceful/destroyed terminal; `errored` = fatal terminal. Both are final.
export type WriterState = 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'closed' | 'errored'

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
// Messages retain only unacknowledged writes. The prefix [0, inflightCount) was
// sent on the current stream; the remaining suffix is waiting to be sent.
export type WriterCtx = {
	// Initial seqNo recovery
	hasEverConnected: boolean

	// seqNo bookkeeping
	lastSeqNo: bigint

	// reconnect bookkeeping
	attempts: number
	lastError: unknown
	// When set, a SCHEME_ERROR (e.g. the topic does not exist yet) is retried instead
	// of being fatal — the writer waits until the topic is created.
	retryOnSchemeError: boolean
	// Terminal reconnect deadline (ms). Infinity = unbounded (reconnect forever); the
	// transition owns whether to arm the `recovery_window` timer based on this.
	recoveryWindowMs: number

	// Each flush captures its last accepted message; calls at the same boundary share one completion.
	flushes: Map<BufferedMessage, number>
	closeRequested: boolean
	// A partial batch is due after its timer fires or after an interrupted stream.
	batchDue: boolean

	// The session codec (Codec enum value / custom id) — validated against
	// InitResponse.supported_codecs: a disallowed codec is fatal at init, before any
	// buffered data reaches the wire (the server would otherwise kill the session
	// with an opaque BAD_REQUEST at the first WriteRequest).
	codec: number

	messages: BufferedMessage[]
	inflightCount: number
	// Sum of compressed payload bytes in the unsent suffix; avoids rescanning a partial batch on every write.
	unsentBytes: bigint

	limits: WriterLimits
}

// Writer lifecycle timers are scoped to the complete write session.
export type GlobalTimerName =
	| 'start_timeout'
	| 'retry_backoff'
	| 'recovery_window'
	| 'update_token'
	| 'graceful_timeout'
	| 'flush_tick'

export type TimerRef = { which: GlobalTimerName }

export type WriterEvent =
	// user (dispatched by the facade)
	| { type: 'writer.start' }
	| { type: 'writer.write'; message: BufferedMessage }
	| { type: 'writer.flush'; requestId: number }
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
			// Codecs the topic permits; empty = the server-side codec check is disabled.
			supportedCodecs?: number[]
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

// transport.* = socket lifecycle only; send.* = anything written to the stream.
export type WriterEffect =
	| { type: 'writer.effect.transport.connect'; getLastSeqNo: boolean }
	| {
			type: 'writer.effect.send.write_request'
			messages: StreamWriteMessage_WriteRequest_MessageData[]
	  }
	| { type: 'writer.effect.send.update_token' }
	| ({ type: 'writer.effect.timer.schedule' } & TimerRef)
	| ({ type: 'writer.effect.timer.clear' } & TimerRef)
	| { type: 'writer.effect.finalize'; reason: unknown }

export type WriterOutput =
	| { type: 'writer.session'; sessionId: string; lastSeqNo: bigint; nextSeqNo: bigint }
	// Compressed payload bytes reclaimed by this ACK batch.
	| {
			type: 'writer.acknowledgments'
			acknowledgments: Map<bigint, AckStatus>
			freedBytes: bigint
	  }
	| { type: 'writer.flushed'; requestId: number; lastSeqNo: bigint }
	| { type: 'writer.reconnecting'; attempt: number; error?: unknown }
	| { type: 'writer.error'; error: unknown }
	| { type: 'writer.closed'; reason?: unknown }

type WriterRuntime = TransitionRuntime<WriterState, WriterEvent, WriterOutput>

// ── Helpers ─────────────────────────────────────────────────────────────────────

export let createWriterCtx = function createWriterCtx(
	limits: WriterLimits,
	options?: { retryOnSchemeError?: boolean; recoveryWindowMs?: number; codec?: number }
): WriterCtx {
	return {
		hasEverConnected: false,

		lastSeqNo: 0n,

		attempts: 0,
		lastError: undefined,
		retryOnSchemeError: options?.retryOnSchemeError ?? false,
		recoveryWindowMs: options?.recoveryWindowMs ?? Infinity,

		flushes: new Map(),
		closeRequested: false,
		batchDue: false,

		// 1 = Codec.RAW, the writer default.
		codec: options?.codec ?? 1,

		messages: [],
		inflightCount: 0,
		unsentBytes: 0n,

		limits,
	}
}

let allDrained = function allDrained(ctx: WriterCtx): boolean {
	return ctx.messages.length === 0
}

// The window has work and headroom: something is buffered and inflight has room.
let canSend = function canSend(ctx: WriterCtx): boolean {
	return (
		ctx.inflightCount < ctx.messages.length && ctx.inflightCount < ctx.limits.maxInflightCount
	)
}

let requestFlush = function requestFlush(
	ctx: WriterCtx,
	runtime: WriterRuntime,
	requestId: number
): void {
	let last = ctx.messages.at(-1)
	if (!last) {
		runtime.emit({ type: 'writer.flushed', requestId, lastSeqNo: ctx.lastSeqNo })
		return
	}

	ctx.flushes.set(last, requestId)
	runtime.dispatch({ type: 'writer.pump' })
}

// Auto sequence numbers are assigned at send time, so a flush follows message identity until ACK.
let removeAcknowledged = function removeAcknowledged(
	ctx: WriterCtx,
	count: number
): WriterOutput[] {
	let completed: WriterOutput[] = []
	for (let message of ctx.messages.splice(0, count)) {
		let requestId = ctx.flushes.get(message)
		if (requestId !== undefined) {
			ctx.flushes.delete(message)
			completed.push({ type: 'writer.flushed', requestId, lastSeqNo: message.seqNo })
		}
	}
	ctx.inflightCount -= count

	return completed
}

// One stream attempt: open the transport and arm its watchdog. Shared by every
// (re)connect site so the pair can never drift apart.
let connectEffects = function connectEffects(ctx: WriterCtx): WriterEffect[] {
	return [
		// Re-request last_seq_no only until it was recovered once — a retry that
		// races the very first connect must not resume at seqNo 0 and silently
		// collide with already-persisted messages.
		{ type: 'writer.effect.transport.connect', getLastSeqNo: !ctx.hasEverConnected },
		{ type: 'writer.effect.timer.schedule', which: 'start_timeout' },
	]
}

// ── Window & batch helpers ──────────────────────────────────────────────────────

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
	let available = ctx.limits.maxInflightCount - ctx.inflightCount
	if (
		!ctx.batchDue &&
		!ctx.closeRequested &&
		ctx.flushes.size === 0 &&
		ctx.messages.length - ctx.inflightCount < available &&
		ctx.unsentBytes < ctx.limits.maxBatchBytes
	) {
		return []
	}

	let count = 0
	let batchBytes = 0n
	for (let i = ctx.inflightCount; i < ctx.messages.length; i++) {
		let size = BigInt(ctx.messages[i]!.data.length)
		if (count > 0 && batchBytes + size > ctx.limits.maxBatchBytes) {
			break
		}
		count++
		batchBytes += size
		if (count === available || batchBytes === ctx.limits.maxBatchBytes) {
			break
		}
	}

	let batch: StreamWriteMessage_WriteRequest_MessageData[] = []
	for (let i = ctx.inflightCount; i < ctx.inflightCount + count; i++) {
		let message = ctx.messages[i]!
		if (message.seqNo === 0n) {
			ctx.lastSeqNo += 1n
			message.seqNo = ctx.lastSeqNo
		}
		batch.push(toMessageData(message))
	}

	ctx.inflightCount += count
	ctx.unsentBytes -= batchBytes
	if (ctx.inflightCount === ctx.messages.length) {
		ctx.batchDue = false
	}

	return batch
}

// Apply a server init: recover the seqNo high-water mark once (auto numbering),
// then drop any server-persisted in-flight messages and rewind the rest for resend.
//
// YDB reports last_seq_no on reconnect even when get_last_seq_no is false. Only
// previously sent messages may be removed using that watermark; unsent auto messages
// have no sequence number yet. If the server reports zero, replay remains safe through
// producer+seqNo deduplication.
let applyInit = function applyInit(
	ctx: WriterCtx,
	sessionId: string,
	serverLastSeqNo: bigint,
	runtime: WriterRuntime
): void {
	if (!ctx.hasEverConnected) {
		// No message can be sent before the first init, so a nonzero buffered seqNo
		// is user-provided. Automatic numbering continues above the recovered value.
		let manual = (ctx.messages[0]?.seqNo ?? 0n) !== 0n
		if (!manual && serverLastSeqNo > ctx.lastSeqNo) {
			ctx.lastSeqNo = serverLastSeqNo
		}

		ctx.hasEverConnected = true
	}

	let { recovered, freedBytes, flushed } = dropAckedAndRewind(ctx, serverLastSeqNo)
	if (recovered.size > 0) {
		runtime.emit({
			type: 'writer.acknowledgments',
			acknowledgments: recovered,
			freedBytes,
		})
	}

	runtime.emit({
		type: 'writer.session',
		sessionId,
		lastSeqNo: ctx.lastSeqNo,
		nextSeqNo: ctx.lastSeqNo + 1n,
	})
	for (let output of flushed) {
		runtime.emit(output)
	}
}

// Drop in-flight messages the server already persisted (seqNo <= serverLastSeqNo),
// surfacing them as `skipped` (deduplicated), and move the remaining unacked
// in-flight messages back to the front of the buffer to be resent in order.
// Only scans the in-flight range; buffered (unsent, unnumbered) messages are untouched.
let dropAckedAndRewind = function dropAckedAndRewind(
	ctx: WriterCtx,
	serverLastSeqNo: bigint
): { recovered: Map<bigint, AckStatus>; freedBytes: bigint; flushed: WriterOutput[] } {
	let recovered = new Map<bigint, AckStatus>()
	let freedBytes = 0n

	// In-flight seqNos are strictly increasing (assigned in order in formBatch), so
	// `seqNo <= serverLastSeqNo` splits the in-flight range at one boundary — walk
	// the acked prefix, exactly like acknowledge() walks the acked prefix.
	let inflightEnd = ctx.inflightCount
	let i = 0
	while (i < inflightEnd) {
		let message = ctx.messages[i]!
		if (message.seqNo === 0n || message.seqNo > serverLastSeqNo) {
			break
		}
		freedBytes += BigInt(message.data.length)
		recovered.set(message.seqNo, 'skipped')
		i += 1
	}

	let resend = i < ctx.inflightCount
	for (let j = i; j < inflightEnd; j++) {
		ctx.unsentBytes += BigInt(ctx.messages[j]!.data.length)
	}

	let flushed = removeAcknowledged(ctx, i)
	ctx.inflightCount = 0
	ctx.batchDue = ctx.messages.length > 0 && (ctx.batchDue || resend)

	return { recovered, freedBytes, flushed }
}

// Remove server-acknowledged messages from the in-flight prefix.
// The server acks the in-flight prefix in order, so we walk from the head and
// stop at the first unacked message. We report only the messages actually removed
// from the window, so the emitted acks and the freed-byte total can never drift
// from the window even if a stream ever delivered a non-prefix ack set.
let acknowledge = function acknowledge(
	ctx: WriterCtx,
	acks: WriteAck[]
): { acknowledgments: Map<bigint, AckStatus>; freedBytes: bigint; flushed: WriterOutput[] } {
	let status = new Map<bigint, AckStatus>()
	for (let ack of acks) {
		status.set(ack.seqNo, ack.status)
	}

	let acknowledgments = new Map<bigint, AckStatus>()
	let freedBytes = 0n
	let count = 0
	while (count < ctx.inflightCount) {
		let message = ctx.messages[count]!
		let messageStatus = status.get(message.seqNo)
		if (messageStatus === undefined) {
			break
		}

		acknowledgments.set(message.seqNo, messageStatus)
		freedBytes += BigInt(message.data.length)
		count += 1
	}

	let flushed = removeAcknowledged(ctx, count)

	return { acknowledgments, freedBytes, flushed }
}

// Append a message to the buffer. Total by design — seqNo-mode validation
// (which must throw synchronously to the caller) lives in the facade, so the
// transition never throws and can never accidentally destroy the machine.
// A non-zero seqNo means the facade already validated a manual message; a zero
// seqNo is an auto message that gets its number at send time (see formBatch).
let enqueue = function enqueue(ctx: WriterCtx, message: BufferedMessage): void {
	let providedSeqNo = message.seqNo !== 0n

	// Manual mode: lastSeqNo tracks the user's high-water mark for resend/recovery.
	if (providedSeqNo) {
		ctx.lastSeqNo = message.seqNo
	}

	ctx.messages.push(message)
	ctx.unsentBytes += BigInt(message.data.length)
}

// ── Terminal / transitions ──────────────────────────────────────────────────────

// Terminal transition into `closed` or `errored`: emit the lifecycle output,
// tear the transport down and finalize. Reused from many states.
let terminate = function terminate(
	ctx: WriterCtx,
	state: 'closed' | 'errored',
	reason: unknown,
	runtime: WriterRuntime
): TransitionResult<WriterState, WriterEffect> {
	if (state === 'errored') {
		ctx.lastError = reason
		runtime.emit({ type: 'writer.error', error: reason })
	}

	runtime.emit({ type: 'writer.closed', reason })

	// Drop any still-buffered/in-flight messages so their payloads can be GC'd —
	// on a terminal stop they will never be sent or acknowledged.
	releaseState(ctx)

	return {
		state,
		// Terminal: the runtime seals itself after the finalize effect runs, so the
		// buffered lifecycle outputs (writer.closed / writer.error) are delivered first.
		final: { reason },
		effects: [
			// No per-timer clears — the finalize handler clears the whole timer map.
			{ type: 'writer.effect.finalize', reason },
		],
	}
}

// Free the message window. Called on terminal stop to release payload memory.
export let releaseState = function releaseState(ctx: WriterCtx): void {
	ctx.messages = []
	ctx.inflightCount = 0
	ctx.unsentBytes = 0n
	ctx.batchDue = false
	ctx.flushes.clear()
}

// Drain buffered messages into the in-flight prefix, one batch per event.
let pump = function pump(
	ctx: WriterCtx,
	runtime: WriterRuntime
): TransitionResult<WriterState, WriterEffect> | void {
	if (!canSend(ctx)) {
		return
	}

	let messages = formBatch(ctx)
	if (messages.length === 0) {
		return
	}

	// More to send and room to send it — keep pumping on the next tick.
	if (canSend(ctx)) {
		runtime.dispatch({ type: 'writer.pump' })
	}

	return { effects: [{ type: 'writer.effect.send.write_request', messages }] }
}

// The server permits only codecs from InitResponse.supported_codecs (empty list =
// check disabled); writing with any other closes the session with an opaque
// BAD_REQUEST after data is already buffered. Failing at init is the only moment
// the writer can stop with an actionable error and nothing lost on the wire.
let codecRejectedByTopic = function codecRejectedByTopic(
	ctx: WriterCtx,
	supportedCodecs: number[] | undefined
): Error | undefined {
	if (!supportedCodecs || supportedCodecs.length === 0) {
		return undefined
	}

	if (supportedCodecs.includes(ctx.codec)) {
		return undefined
	}

	return new Error(
		`Codec ${ctx.codec} is not allowed by the topic (supported codecs: ${supportedCodecs.join(', ')})`
	)
}

// Enter `ready` on a successful init — from `connecting`, or from `reconnecting`
// when a slow init lands after start_timeout already moved us there. Recover the
// seqNo state, resolve any pending flush the recovery just drained, and resume.
let toReady = function toReady(
	ctx: WriterCtx,
	event: Extract<WriterEvent, { type: 'writer.stream.init_response' }>,
	runtime: WriterRuntime
): TransitionResult<WriterState, WriterEffect> {
	let codecError = codecRejectedByTopic(ctx, event.supportedCodecs)
	if (codecError) {
		return terminate(ctx, 'errored', codecError, runtime)
	}

	ctx.attempts = 0
	applyInit(ctx, event.sessionId, event.lastSeqNo, runtime)
	let closed = finishDrain(ctx, runtime)
	if (closed) {
		return closed
	}

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
	if (error !== undefined) {
		ctx.lastError = error
	}
	// Reconnecting must not restart the batching delay for already accepted messages.
	ctx.batchDue = ctx.messages.length > 0

	runtime.emit({
		type: 'writer.reconnecting',
		attempt: ctx.attempts,
		...(error !== undefined && { error }),
	})
	// The disconnected transport already released its stream; connect reopens it.
	let effects: WriterEffect[] = [
		{ type: 'writer.effect.timer.clear', which: 'start_timeout' },
		{ type: 'writer.effect.timer.clear', which: 'flush_tick' },
		{ type: 'writer.effect.timer.clear', which: 'update_token' },
		{ type: 'writer.effect.timer.schedule', which: 'retry_backoff' },
	]
	// Arm the terminal deadline only when recovery is bounded. Unbounded (Infinity)
	// means reconnect forever — the transition owns that policy so the emitted effects
	// reflect it (model-testable), instead of the runtime silently dropping the timer.
	if (!ctx.closeRequested && Number.isFinite(ctx.recoveryWindowMs)) {
		effects.push({ type: 'writer.effect.timer.schedule', which: 'recovery_window' })
	}

	return { state: 'reconnecting', effects }
}

let finishDrain = function finishDrain(
	ctx: WriterCtx,
	runtime: WriterRuntime
): TransitionResult<WriterState, WriterEffect> | undefined {
	if (ctx.closeRequested && allDrained(ctx)) {
		return terminate(ctx, 'closed', new Error('Writer closed'), runtime)
	}

	return undefined
}

// ── Transition ──────────────────────────────────────────────────────────────────

// Deliberately-ignored (state, event) pairs route through here so an unhandled
// event shows up in debug logs instead of vanishing.
let ignored = function ignored(state: WriterState, event: WriterEvent): void {
	dbg.log('ignoring %s in state %s', event.type, state)
}

export let writerTransition = function writerTransition(
	ctx: WriterCtx,
	event: WriterEvent,
	runtime: WriterRuntime
): TransitionResult<WriterState, WriterEffect> | void {
	let state = runtime.state
	if (state === 'closed' || state === 'errored') {
		return ignored(state, event)
	}

	switch (event.type) {
		case 'writer.destroy':
			return terminate(ctx, 'closed', event.reason ?? new Error('Writer destroyed'), runtime)
		case 'writer.close': {
			if (ctx.closeRequested) {
				return
			}

			ctx.closeRequested = true
			let closed = finishDrain(ctx, runtime)
			if (closed) {
				return closed
			}

			if (state === 'idle') {
				runtime.dispatch({ type: 'writer.start' })
			}

			if (state === 'ready') {
				runtime.dispatch({ type: 'writer.pump' })
			}

			return {
				effects: [
					{ type: 'writer.effect.timer.clear', which: 'recovery_window' },
					{ type: 'writer.effect.timer.schedule', which: 'graceful_timeout' },
				],
			}
		}
		case 'writer.write':
			if (ctx.closeRequested) {
				return ignored(state, event)
			}

			enqueue(ctx, event.message)
			if (state === 'ready') {
				runtime.dispatch({ type: 'writer.pump' })
			}
			return
		case 'writer.flush':
			requestFlush(ctx, runtime, event.requestId)
			return
		case 'writer.timer.flush_tick':
			if (ctx.messages.length > ctx.inflightCount) {
				ctx.batchDue = true
			}

			if (state === 'ready') {
				return pump(ctx, runtime)
			}
			return
		case 'writer.timer.graceful_timeout':
			if (!ctx.closeRequested) {
				return ignored(state, event)
			}

			if (!allDrained(ctx)) {
				return terminate(
					ctx,
					'errored',
					new Error('Graceful shutdown timed out with undelivered messages'),
					runtime
				)
			}

			return finishDrain(ctx, runtime)
	}

	switch (state) {
		case 'idle':
			if (event.type === 'writer.start') {
				return { state: 'connecting', effects: connectEffects(ctx) }
			}

			return ignored(state, event)

		case 'connecting':
		case 'reconnecting':
			switch (event.type) {
				case 'writer.stream.init_response':
					return toReady(ctx, event, runtime)
				case 'writer.timer.start_timeout':
					if (state === 'connecting') {
						return toReconnecting(ctx, undefined, runtime)
					}

					return ignored(state, event)
				case 'writer.timer.retry_backoff':
					if (state !== 'reconnecting') {
						return ignored(state, event)
					}

					ctx.attempts += 1
					return { state: 'connecting', effects: connectEffects(ctx) }
				case 'writer.stream.disconnected':
					if (!isRetryableTopicError(event.error, ctx.retryOnSchemeError)) {
						return terminate(ctx, 'errored', event.error, runtime)
					}

					if (state === 'connecting') {
						return toReconnecting(ctx, event.error, runtime)
					}

					if (event.error !== undefined) {
						ctx.lastError = event.error
					}
					return
				case 'writer.timer.recovery_window':
					if (ctx.closeRequested) {
						return ignored(state, event)
					}

					return terminate(
						ctx,
						'errored',
						ctx.lastError ?? new Error('Writer recovery window expired'),
						runtime
					)
				default:
					return ignored(state, event)
			}

		case 'ready':
			switch (event.type) {
				case 'writer.pump':
					return pump(ctx, runtime)
				case 'writer.stream.write_response': {
					let { acknowledgments, freedBytes, flushed } = acknowledge(ctx, event.acks)
					if (acknowledgments.size > 0) {
						runtime.emit({
							type: 'writer.acknowledgments',
							acknowledgments,
							freedBytes,
						})
					}

					for (let output of flushed) {
						runtime.emit(output)
					}

					let closed = finishDrain(ctx, runtime)
					if (closed) {
						return closed
					}

					runtime.dispatch({ type: 'writer.pump' })
					return
				}
				case 'writer.timer.update_token':
					return { effects: [{ type: 'writer.effect.send.update_token' }] }
				case 'writer.stream.token_response':
					return
				case 'writer.stream.disconnected':
					if (!isRetryableTopicError(event.error, ctx.retryOnSchemeError)) {
						return terminate(ctx, 'errored', event.error, runtime)
					}

					return toReconnecting(ctx, event.error, runtime)
				default:
					return ignored(state, event)
			}
	}
}
