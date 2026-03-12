import { create } from '@bufbuild/protobuf'
import {
	SessionRequest_PingPongSchema,
	SessionRequest_SessionStartSchema,
	SessionRequest_SessionStopSchema,
	type SessionResponse,
} from '@ydbjs/api/coordination'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { loggers } from '@ydbjs/debug'
import { type EffectRuntime } from '@ydbjs/fsm'
import { AsyncQueue } from '@ydbjs/fsm/queue'

import type { CoordinationSessionOptions } from './session-options.js'
import { type SessionRequestRegistry } from './session-registry.js'
import { type SessionEvent, type SessionOutput, type SessionState } from './session-state.js'

let dbg = loggers.topic.extend('coordination').extend('session-stream')

// ── exported types ─────────────────────────────────────────────────────────────

// The wire envelope for every message sent on the bidirectional gRPC stream.
export type SessionStreamRequest = {
	request: {
		case: string
		value: unknown
	}
}

// Minimal gRPC client shape the stream open code relies on.
// The full generated client is cast to this type to keep the dependency narrow.
export type CoordinationSessionClient = {
	session(
		request: AsyncIterable<SessionStreamRequest>,
		options?: { signal?: AbortSignal }
	): AsyncIterable<SessionResponse>
}

// A single watch-change notification pushed into the watch queue when the
// server sends a describeSemaphoreChanged message.
export type WatchChange = {
	dataChanged: boolean
	ownersChanged: boolean
}

// Per-semaphore watch subscription state.  Keyed by name in watchesByName and
// by reqId in watchesByReqId for O(1) lookup from both directions.
export type WatchRegistration = {
	queue: AsyncQueue<WatchChange>
	reqId: bigint
	signalController: AbortController
}

// ── local context shape ────────────────────────────────────────────────────────

// Structural type capturing the fields that stream functions read and mutate.
// SessionFullCtx in session-runtime.ts satisfies this type via structural
// compatibility — no explicit import of SessionFullCtx is needed here.
type StreamCtx = {
	client: CoordinationSessionClient
	options: CoordinationSessionOptions
	sessionId: bigint | null
	signal: AbortSignal | undefined
	streamInput: AsyncQueue<SessionStreamRequest> | null
	streamAbortController: AbortController | null
	streamIngest: AsyncDisposable | null
	requests: SessionRequestRegistry
	watchesByName: Map<string, WatchRegistration>
	watchesByReqId: Map<bigint, { name: string; queue: AsyncQueue<WatchChange> }>
}

// ── helpers ────────────────────────────────────────────────────────────────────

let isAbortError = function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === 'AbortError'
}

// ── protocol message sends ─────────────────────────────────────────────────────

export let sendRequest = function sendRequest(ctx: StreamCtx, request: SessionStreamRequest): void {
	let input = ctx.streamInput
	if (!input || input.isClosed || input.isDestroyed) {
		dbg.log('stream request skipped, input unavailable: %s', request.request.case)
		return
	}

	input.push(request)
}

export let sendStart = function sendStart(ctx: StreamCtx): void {
	sendRequest(ctx, {
		request: {
			case: 'sessionStart',
			value: create(SessionRequest_SessionStartSchema, {
				path: ctx.options.path,
				sessionId: ctx.sessionId ?? 0n,
				timeoutMillis: BigInt(ctx.options.recoveryWindow ?? 30_000),
				description: ctx.options.description ?? '',
				seqNo: 0n,
				protectionKey: new Uint8Array(),
			}),
		},
	})
}

export let sendStop = function sendStop(ctx: StreamCtx): void {
	sendRequest(ctx, {
		request: {
			case: 'sessionStop',
			value: create(SessionRequest_SessionStopSchema, {}),
		},
	})
}

export let sendPong = function sendPong(ctx: StreamCtx, opaque: bigint): void {
	sendRequest(ctx, {
		request: {
			case: 'pong',
			value: create(SessionRequest_PingPongSchema, { opaque }),
		},
	})
}

// ── response routing ───────────────────────────────────────────────────────────

// Extract the wire-level reqId from any response that carries one.
// Returns null for protocol-level messages (ping, sessionStarted, etc.)
// that are dispatched as FSM events rather than resolved as request futures.
let getResponseReqId = function getResponseReqId(response: SessionResponse): bigint | null {
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

// Map a raw server response to either an FSM event (for protocol messages) or
// null (for request-response messages that are delivered to their registered
// deferred directly via the request registry).
export let routeResponse = function routeResponse(
	ctx: StreamCtx,
	response: SessionResponse
): SessionEvent | null {
	// Watch change notifications are pushed to the semaphore watch queue and
	// never reach the FSM as events.
	if (response.response.case === 'describeSemaphoreChanged') {
		let watcher = ctx.watchesByReqId.get(response.response.value.reqId)
		if (watcher) {
			let active = ctx.watchesByName.get(watcher.name)
			if (
				active &&
				active.reqId === response.response.value.reqId &&
				active.queue === watcher.queue
			) {
				watcher.queue.push({
					dataChanged: response.response.value.dataChanged,
					ownersChanged: response.response.value.ownersChanged,
				})
			}
		}

		return null
	}

	// Request-response messages — resolve the waiting deferred and return null
	// so the ingest loop does not dispatch anything to the FSM.
	let reqId = getResponseReqId(response)
	if (reqId !== null && ctx.requests.resolve(reqId, response)) {
		return null
	}

	// Protocol-level messages become FSM events.
	if (response.response.case === 'ping') {
		return {
			type: 'session.stream.response.ping',
			opaque: response.response.value.opaque,
		}
	}

	if (response.response.case === 'sessionStarted') {
		return {
			type: 'session.stream.response.started',
			sessionId: response.response.value.sessionId,
		}
	}

	if (response.response.case === 'sessionStopped') {
		return {
			type: 'session.stream.response.stopped',
			sessionId: response.response.value.sessionId,
		}
	}

	if (response.response.case === 'failure') {
		return {
			type: 'session.stream.response.failure',
			status: response.response.value.status as StatusIds_StatusCode,
			issues: response.response.value.issues,
		}
	}

	return null
}

// ── stream lifecycle ───────────────────────────────────────────────────────────

export let openStream = async function openStream(
	ctx: StreamCtx,
	runtime: EffectRuntime<SessionState, SessionEvent, SessionOutput>
): Promise<void> {
	if (ctx.streamIngest) {
		dbg.log('stream open skipped, ingest already active')
		return
	}

	dbg.log('opening session stream for path: %s', ctx.options.path)

	let streamInput = new AsyncQueue<SessionStreamRequest>()
	let streamAbortController = new AbortController()
	let streamSignal = ctx.signal
		? AbortSignal.any([streamAbortController.signal, ctx.signal])
		: streamAbortController.signal
	let grpcStream = ctx.client.session(streamInput, { signal: streamSignal })

	ctx.streamInput = streamInput
	ctx.streamAbortController = streamAbortController

	sendStart(ctx)

	// Declared before the generator so the finally block can reference it via
	// closure.  Assigned immediately after runtime.ingest() returns the handle.
	let ingestHandle: AsyncDisposable | null = null

	let source = (async function* (): AsyncIterable<SessionResponse> {
		try {
			for await (let response of grpcStream) {
				yield response
			}
		} catch (error) {
			if (!isAbortError(error)) {
				runtime.dispatch({
					type: 'session.internal.fatal',
					error,
				})
			}
		} finally {
			streamInput.close()

			if (ctx.streamInput === streamInput) {
				ctx.streamInput = null
			}

			if (ctx.streamAbortController === streamAbortController) {
				ctx.streamAbortController = null
			}

			// Clear the ingest handle so that the next openStream call (on reconnect)
			// does not see a stale non-null value and bail out early.  Only clear if
			// this generator instance still owns the slot — a concurrent closeStream
			// or a new openStream may have already replaced it.
			if (ctx.streamIngest === ingestHandle) {
				ctx.streamIngest = null
				runtime.dispatch({ type: 'session.stream.disconnected' })
			}
		}
	})()

	ingestHandle = runtime.ingest(
		source,
		(response: SessionResponse) => routeResponse(ctx, response),
		streamSignal
	)
	ctx.streamIngest = ingestHandle
	runtime.dispatch({ type: 'session.stream.connected' })
}

export let closeStream = async function closeStream(ctx: StreamCtx): Promise<void> {
	let ingest = ctx.streamIngest
	ctx.streamIngest = null

	// Abort the stream transport signal first so the source generator unblocks
	// from its grpcStream read.  The ingest task's combined signal includes
	// streamAbortController.signal, so aborting here lets the ingest loop exit
	// cleanly.  If we awaited ingest dispose first we would deadlock — the
	// ingest task cannot finish while the grpcStream is still waiting for input.
	if (ctx.streamAbortController) {
		ctx.streamAbortController.abort(new Error('Session transport stopped'))
		ctx.streamAbortController = null
	}

	if (ctx.streamInput) {
		ctx.streamInput.close()
		ctx.streamInput = null
	}

	if (ingest) {
		await ingest[Symbol.asyncDispose]()
	}
}
