import { create } from '@bufbuild/protobuf'
import { timestampFromDate } from '@bufbuild/protobuf/wkt'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import {
	type StreamWriteMessage_WriteRequest_MessageData,
	StreamWriteMessage_WriteRequest_MessageDataSchema,
} from '@ydbjs/api/topic'
import { loggers } from '@ydbjs/debug'
import { YDBError } from '@ydbjs/error'
import type { TransitionResult, TransitionRuntime } from '@ydbjs/fsm'
import { isRetryableError, isRetryableStreamError } from '@ydbjs/retry'
import { ClientError, Status } from 'nice-grpc'

import type { AckStatus, WriteAck } from './types.js'

// The pure half of the writer: states, context, and a synchronous transition
// with no I/O. Everything here mutates `ctx` in place and returns the next
// state + a list of effects for the runtime to execute — see writer-runtime.ts
// for the I/O side. The buffer is a sliding window (see WriterCtx) and byte
// budgeting lives in the facade, so the transition only counts messages.
//
// The full transition map (table + diagram) lives in packages/topic/ARCHITECTURE.md —
// update it in the same commit when you change this dispatch.

let dbg = loggers.topic.extend('writer')

// Hard service limits (bytes).
export const MAX_BATCH_BYTES = 48n * 1024n * 1024n // one WriteRequest frame stays under 48MiB
export const MAX_PAYLOAD_BYTES = 48n * 1024n * 1024n // single message payload cap

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
	bufferedSize: bigint
	wireSize: bigint
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

	// Highest pending flush call processed by the FSM, not the newest facade call.
	pendingFlushId: number | undefined
	closeRequested: boolean
	// A partial batch is due after its timer fires or after an interrupted send.
	batchDue: boolean

	// The session codec (Codec enum value / custom id) — validated against
	// InitResponse.supported_codecs: a disallowed codec is fatal at init, before any
	// buffered data reaches the wire (the server would otherwise kill the session
	// with an opaque BAD_REQUEST at the first WriteRequest).
	codec: number

	messages: BufferedMessage[]
	inflightCount: number
	// Sum of wireSize in the unsent suffix; avoids rescanning a partial batch on every write.
	bufferedWireBytes: bigint

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
	// Budget reclaimed by this ack batch and payload bytes for throughput diagnostics.
	| {
			type: 'writer.acknowledgments'
			acknowledgments: Map<bigint, AckStatus>
			freedBytes: bigint
			payloadBytes: bigint
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

		pendingFlushId: undefined,
		closeRequested: false,
		batchDue: false,

		// 1 = Codec.RAW, the writer default.
		codec: options?.codec ?? 1,

		messages: [],
		inflightCount: 0,
		bufferedWireBytes: 0n,

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

// A size-limit rejection is deterministic — resending the same oversized frame can
// only fail again, so it must be fatal (Go demotes this case explicitly). Every
// size rejection observed against a real server (tests/writer-protocol.test.ts) is
// a gRPC ClientError RESOURCE_EXHAUSTED whose details carry a size complaint:
//   server frame cap: 'Received message larger than max (66060326 vs. 64000000)'
//   client send cap:  'Attempted to send message with a size larger than 67108864'
// (grpc-js receive paths use the same 'larger than' wording). The code alone is not
// enough — RESOURCE_EXHAUSTED also covers genuine throttling, which SHOULD be
// retried — so the details text narrows it. Everything else the server could send
// (e.g. a YDBError BAD_REQUEST issue) is already non-retryable via the generic
// classifier and needs no special case here.
let isPayloadTooLargeError = function isPayloadTooLargeError(error: unknown): boolean {
	return (
		error instanceof ClientError &&
		error.code === Status.RESOURCE_EXHAUSTED &&
		/larger than/i.test(error.details)
	)
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

// Resolve a pending flush the moment the window is empty. Every path that can
// drain the buffer (a write_response ack, or a reconnect whose init dedups all
// in-flight messages) must call this — otherwise a flush that drains via the
// dedup path never emits writer.flushed and the caller hangs forever.
let resolveFlushIfDrained = function resolveFlushIfDrained(
	ctx: WriterCtx,
	runtime: WriterRuntime
): void {
	let requestId = ctx.pendingFlushId
	if (requestId !== undefined && allDrained(ctx)) {
		ctx.pendingFlushId = undefined
		runtime.emit({
			type: 'writer.flushed',
			requestId,
			lastSeqNo: ctx.lastSeqNo,
		})
	}
}

// Record a flush request. Honored in every live state — a flush issued while the
// writer is still connecting must resolve once messages drain after init, not be
// dropped. Resolves immediately when there is nothing pending.
let requestFlush = function requestFlush(
	ctx: WriterCtx,
	runtime: WriterRuntime,
	requestId: number
): void {
	ctx.pendingFlushId = requestId
	resolveFlushIfDrained(ctx, runtime)
	// Still pending — kick the send loop to drain it.
	if (ctx.pendingFlushId !== undefined) {
		runtime.dispatch({ type: 'writer.pump' })
	}
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
		ctx.pendingFlushId === undefined &&
		ctx.messages.length - ctx.inflightCount < available &&
		ctx.bufferedWireBytes < ctx.limits.maxBatchBytes
	) {
		return []
	}

	let count = 0
	let batchBytes = 0n
	for (let i = ctx.inflightCount; i < ctx.messages.length; i++) {
		let size = ctx.messages[i]!.wireSize
		if (batchBytes + size > ctx.limits.maxBatchBytes) {
			if (count === 0) throw new Error('Message exceeds the protobuf write frame limit')
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
	ctx.bufferedWireBytes -= batchBytes
	if (ctx.inflightCount === ctx.messages.length) ctx.batchDue = false
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
	if (!ctx.hasEverConnected) {
		// No message can be sent before the first init, so a nonzero buffered seqNo
		// is user-provided. Automatic numbering continues above the recovered value.
		let manual = (ctx.messages[0]?.seqNo ?? 0n) !== 0n
		if (!manual && serverLastSeqNo > ctx.lastSeqNo) {
			ctx.lastSeqNo = serverLastSeqNo
		}
		ctx.hasEverConnected = true
	}

	let { recovered, freedBytes, payloadBytes } = dropAckedAndRewind(ctx, serverLastSeqNo)
	if (recovered.size > 0) {
		runtime.emit({
			type: 'writer.acknowledgments',
			acknowledgments: recovered,
			freedBytes,
			payloadBytes,
		})
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
): { recovered: Map<bigint, AckStatus>; freedBytes: bigint; payloadBytes: bigint } {
	let recovered = new Map<bigint, AckStatus>()
	let freedBytes = 0n
	let payloadBytes = 0n

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
		freedBytes += message.bufferedSize
		payloadBytes += BigInt(message.data.length)
		recovered.set(message.seqNo, 'skipped')
		i += 1
	}

	let resend = i < ctx.inflightCount
	for (let j = i; j < inflightEnd; j++) {
		ctx.bufferedWireBytes += ctx.messages[j]!.wireSize
	}
	ctx.messages.splice(0, i)
	ctx.inflightCount = 0
	ctx.batchDue = ctx.messages.length > 0 && (ctx.batchDue || resend)

	return { recovered, freedBytes, payloadBytes }
}

// Remove server-acknowledged messages from the in-flight prefix.
// The server acks the in-flight prefix in order, so we walk from the head and
// stop at the first unacked message. We report only the messages actually removed
// from the window, so the emitted acks and the freed-byte total can never drift
// from the window even if a stream ever delivered a non-prefix ack set.
let acknowledge = function acknowledge(
	ctx: WriterCtx,
	acks: WriteAck[]
): { acknowledgments: Map<bigint, AckStatus>; freedBytes: bigint; payloadBytes: bigint } {
	let status = new Map<bigint, AckStatus>()
	for (let ack of acks) {
		status.set(ack.seqNo, ack.status)
	}

	let acknowledgments = new Map<bigint, AckStatus>()
	let freedBytes = 0n
	let payloadBytes = 0n
	let count = 0
	while (count < ctx.inflightCount) {
		let message = ctx.messages[count]!
		let messageStatus = status.get(message.seqNo)
		if (messageStatus === undefined) {
			break
		}

		acknowledgments.set(message.seqNo, messageStatus)
		freedBytes += message.bufferedSize
		payloadBytes += BigInt(message.data.length)
		count += 1
	}

	ctx.messages.splice(0, count)
	ctx.inflightCount -= count

	return { acknowledgments, freedBytes, payloadBytes }
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
	ctx.bufferedWireBytes += message.wireSize
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
	ctx.bufferedWireBytes = 0n
	ctx.batchDue = false
	ctx.pendingFlushId = undefined
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
	if (closed) return closed

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
	resolveFlushIfDrained(ctx, runtime)
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
	if (state === 'closed' || state === 'errored') return ignored(state, event)

	switch (event.type) {
		case 'writer.destroy':
			return terminate(ctx, 'closed', event.reason ?? new Error('Writer destroyed'), runtime)
		case 'writer.close': {
			if (ctx.closeRequested) return
			ctx.closeRequested = true
			let closed = finishDrain(ctx, runtime)
			if (closed) return closed
			if (state === 'idle') runtime.dispatch({ type: 'writer.start' })
			if (state === 'ready') runtime.dispatch({ type: 'writer.pump' })
			return {
				effects: [
					{ type: 'writer.effect.timer.clear', which: 'recovery_window' },
					{ type: 'writer.effect.timer.schedule', which: 'graceful_timeout' },
				],
			}
		}
		case 'writer.write':
			if (ctx.closeRequested) return ignored(state, event)
			enqueue(ctx, event.message)
			if (state === 'ready') runtime.dispatch({ type: 'writer.pump' })
			return
		case 'writer.flush':
			requestFlush(ctx, runtime, event.requestId)
			return
		case 'writer.timer.flush_tick':
			if (ctx.messages.length > ctx.inflightCount) ctx.batchDue = true
			if (state === 'ready') return pump(ctx, runtime)
			return
		case 'writer.timer.graceful_timeout':
			if (!ctx.closeRequested) return ignored(state, event)
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
			if (event.type === 'writer.start')
				return { state: 'connecting', effects: connectEffects(ctx) }
			return ignored(state, event)

		case 'connecting':
		case 'reconnecting':
			switch (event.type) {
				case 'writer.stream.init_response':
					return toReady(ctx, event, runtime)
				case 'writer.timer.start_timeout':
					if (state === 'connecting') return toReconnecting(ctx, undefined, runtime)
					return ignored(state, event)
				case 'writer.timer.retry_backoff':
					if (state !== 'reconnecting') return ignored(state, event)
					ctx.attempts += 1
					return { state: 'connecting', effects: connectEffects(ctx) }
				case 'writer.stream.disconnected':
					if (!isRetryableWriterError(event.error, ctx.retryOnSchemeError)) {
						return terminate(ctx, 'errored', event.error, runtime)
					}
					if (state === 'connecting') return toReconnecting(ctx, event.error, runtime)
					if (event.error !== undefined) ctx.lastError = event.error
					return
				case 'writer.timer.recovery_window':
					if (ctx.closeRequested) return ignored(state, event)
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
					let { acknowledgments, freedBytes, payloadBytes } = acknowledge(ctx, event.acks)
					if (acknowledgments.size > 0) {
						runtime.emit({
							type: 'writer.acknowledgments',
							acknowledgments,
							freedBytes,
							payloadBytes,
						})
					}
					let closed = finishDrain(ctx, runtime)
					if (closed) return closed
					runtime.dispatch({ type: 'writer.pump' })
					return
				}
				case 'writer.timer.update_token':
					return { effects: [{ type: 'writer.effect.send.update_token' }] }
				case 'writer.stream.token_response':
					return
				case 'writer.stream.disconnected':
					if (!isRetryableWriterError(event.error, ctx.retryOnSchemeError)) {
						return terminate(ctx, 'errored', event.error, runtime)
					}
					return toReconnecting(ctx, event.error, runtime)
				default:
					return ignored(state, event)
			}
	}
}
