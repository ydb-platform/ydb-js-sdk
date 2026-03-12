import { create } from '@bufbuild/protobuf'
import { abortable } from '@ydbjs/abortable'
import {
	CoordinationServiceDefinition,
	SessionRequest_AcquireSemaphoreSchema,
	SessionRequest_CreateSemaphoreSchema,
	SessionRequest_DeleteSemaphoreSchema,
	SessionRequest_DescribeSemaphoreSchema,
	SessionRequest_PingPongSchema,
	SessionRequest_ReleaseSemaphoreSchema,
	SessionRequest_SessionStartSchema,
	SessionRequest_SessionStopSchema,
	SessionRequest_UpdateSemaphoreSchema,
	type SessionResponse,
} from '@ydbjs/api/coordination'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import type { Driver } from '@ydbjs/core'
import { loggers } from '@ydbjs/debug'
import { YDBError } from '@ydbjs/error'
import { type EffectRuntime, type MachineRuntime, createMachineRuntime } from '@ydbjs/fsm'
import { AsyncQueue } from '@ydbjs/fsm/queue'

import {
	type SessionCtx,
	type SessionEffect,
	type SessionEvent,
	type SessionOutput,
	type SessionState,
	createSessionCtx,
	sessionTransition,
} from './session-state.js'
import type { CoordinationSessionOptions } from './session-options.js'
import type {
	AcquireSemaphoreOptions,
	CreateSemaphoreOptions,
	DeleteSemaphoreOptions,
	DescribeSemaphoreOptions,
	LeaseRuntime,
	SemaphoreDescription,
	SemaphoreRuntime,
	WatchSemaphoreOptions,
} from './semaphore-runtime.js'
import * as assert from 'node:assert'

let dbg = loggers.topic.extend('coordination').extend('session-runtime')

type SessionStreamRequest = {
	request: {
		case: string
		value: unknown
	}
}

type CoordinationSessionClient = {
	session(
		request: AsyncIterable<SessionStreamRequest>,
		options?: { signal?: AbortSignal }
	): AsyncIterable<SessionResponse>
}

type Deferred<T> = {
	promise: Promise<T>
	resolve(value: T | PromiseLike<T>): void
	reject(reason?: unknown): void
}

type PendingSessionRequest = {
	resolve(response: SessionResponse): void
	reject(reason?: unknown): void
}

type WatchChange = {
	dataChanged: boolean
	ownersChanged: boolean
}

type WatchRegistration = {
	queue: AsyncQueue<WatchChange>
	reqId: bigint
	signalController: AbortController
}

class SessionReconnectError extends Error {
	constructor() {
		super('Session reconnecting')
		this.name = 'SessionReconnectError'
	}
}

class SessionRequestRegistry implements Disposable {
	#nextReqId = 1n
	#closed = false
	#destroyed = false
	#pending = new Map<bigint, PendingSessionRequest>()

	nextReqId(): bigint {
		if (this.#closed || this.#destroyed) {
			throw new Error('Session request registry is closed')
		}

		let reqId = this.#nextReqId
		this.#nextReqId += 1n

		return reqId
	}

	register(reqId: bigint): Deferred<SessionResponse> {
		if (this.#closed || this.#destroyed) {
			throw new Error('Session request registry is closed')
		}

		let deferred = createDeferred<SessionResponse>()

		let resolve = deferred.resolve
		let reject = deferred.reject

		this.#pending.set(reqId, { resolve, reject })

		return deferred
	}

	delete(reqId: bigint): void {
		this.#pending.delete(reqId)
	}

	resolve(reqId: bigint, response: SessionResponse): boolean {
		let pending = this.#pending.get(reqId)
		if (!pending) {
			return false
		}

		this.#pending.delete(reqId)
		pending.resolve(response)

		return true
	}

	// Reject all pending requests with a retryable reconnect error.
	// Called when the session enters reconnecting so in-flight requests
	// loop back to waitReady and re-send after the session recovers.
	reconnect() {
		if (this.#closed || this.#destroyed) {
			return
		}

		for (let [, pending] of this.#pending) {
			pending.reject(new SessionReconnectError())
		}

		this.#pending.clear()
	}

	close() {
		if (this.#closed || this.#destroyed) {
			return
		}

		this.#closed = true

		for (let [, pending] of this.#pending) {
			pending.reject(new Error('Session closed'))
		}

		this.#pending.clear()
	}

	destroy(reason: unknown) {
		if (this.#destroyed) {
			return
		}

		this.#destroyed = true
		this.#closed = true

		for (let [, pending] of this.#pending) {
			pending.reject(reason)
		}

		this.#pending.clear()
	}

	[Symbol.dispose]() {
		this.destroy(new Error('Session request registry disposed'))
	}
}

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

export type SessionStatus = SessionState

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

let createDeferred = function createDeferred<T>(): Deferred<T> {
	let promise = Promise.withResolvers<T>()

	// Attach a no-op catch so that if the deferred is rejected but nobody is
	// currently awaiting it (e.g. before waitReady() is first called), Node.js
	// does not raise an UnhandledPromiseRejection.  Callers that do await the
	// promise will still receive the rejection normally through their own chain.
	promise.promise.catch(() => {})

	return {
		promise: promise.promise,
		resolve: promise.resolve,
		reject: promise.reject,
	}
}

let isAbortError = function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === 'AbortError'
}

let clearTimer = function clearTimer(timer: NodeJS.Timeout | null): null {
	if (timer) {
		clearTimeout(timer)
	}

	return null
}

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

let closeWatchRegistration = function closeWatchRegistration(
	ctx: SessionFullCtx,
	name: string,
	registration: WatchRegistration,
	reason: unknown
): void {
	let active = ctx.watchesByName.get(name)
	if (active === registration) {
		ctx.watchesByName.delete(name)
	}

	if (registration.reqId !== 0n) {
		ctx.watchesByReqId.delete(registration.reqId)
	}

	registration.signalController.abort(reason)
	registration.queue.close()
}

let closeAllWatches = function closeAllWatches(ctx: SessionFullCtx, reason: unknown): void {
	let watches = Array.from(ctx.watchesByName.entries())

	for (let [name, watch] of watches) {
		closeWatchRegistration(ctx, name, watch, reason)
	}
}

let finalizeRuntime = function finalizeRuntime(
	ctx: SessionFullCtx,
	reason: unknown,
	kind: 'closed' | 'expired'
): void {
	if (ctx.isFinalized) {
		return
	}

	ctx.isFinalized = true
	closeAllWatches(ctx, reason)
	ctx.requests.destroy(reason)
	ctx.readyDeferred.reject(reason)
	ctx.closedDeferred.resolve()
	ctx.signalController.abort(reason)

	if (kind === 'expired') {
		dbg.log('runtime finalized as expired: %O', reason)
		return
	}

	dbg.log('runtime finalized as closed: %O', reason)
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

let sendRequest = function sendRequest(ctx: SessionFullCtx, request: SessionStreamRequest): void {
	let input = ctx.streamInput
	if (!input || input.isClosed || input.isDestroyed) {
		dbg.log('stream request skipped, input unavailable: %s', request.request.case)
		return
	}

	input.push(request)
}

let sendStart = function sendStart(ctx: SessionFullCtx): void {
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

let sendStop = function sendStop(ctx: SessionFullCtx): void {
	sendRequest(ctx, {
		request: {
			case: 'sessionStop',
			value: create(SessionRequest_SessionStopSchema, {}),
		},
	})
}

let sendPong = function sendPong(ctx: SessionFullCtx, opaque: bigint): void {
	sendRequest(ctx, {
		request: {
			case: 'pong',
			value: create(SessionRequest_PingPongSchema, { opaque }),
		},
	})
}

let getResponseReqId = function getResponseReqId(response: SessionResponse): bigint | null {
	if (response.response.case === 'acquireSemaphorePending') {
		return response.response.value.reqId
	}

	if (response.response.case === 'acquireSemaphoreResult') {
		return response.response.value.reqId
	}

	if (response.response.case === 'releaseSemaphoreResult') {
		return response.response.value.reqId
	}

	if (response.response.case === 'createSemaphoreResult') {
		return response.response.value.reqId
	}

	if (response.response.case === 'updateSemaphoreResult') {
		return response.response.value.reqId
	}

	if (response.response.case === 'deleteSemaphoreResult') {
		return response.response.value.reqId
	}

	if (response.response.case === 'describeSemaphoreResult') {
		return response.response.value.reqId
	}

	return null
}

let routeResponse = function routeResponse(
	ctx: SessionFullCtx,
	response: SessionResponse
): SessionEvent | null {
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

	let reqId = getResponseReqId(response)
	if (reqId !== null && ctx.requests.resolve(reqId, response)) {
		return null
	}

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

let openStream = async function openStream(
	ctx: SessionFullCtx,
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
	// closure. Assigned immediately after runtime.ingest() returns the handle.
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

			// Clear the ingest handle so that the next openStream call (on
			// reconnect) does not see a stale non-null value and bail out early.
			// Only clear if this generator instance still owns the handle — a
			// concurrent closeStream or a new openStream may have already replaced it.
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

let closeStream = async function closeStream(ctx: SessionFullCtx): Promise<void> {
	let ingest = ctx.streamIngest
	ctx.streamIngest = null

	// Abort the stream transport signal first so the source generator unblocks
	// from its grpcStream read. The ingest task's combined signal includes
	// streamAbortController.signal, so aborting here lets the ingest loop exit
	// cleanly. If we awaited ingest dispose first we would deadlock — the ingest
	// task can't finish while the grpcStream is still waiting for input.
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

let waitReady = async function waitReady(ctx: SessionFullCtx, signal?: AbortSignal): Promise<void> {
	let targetSignal = createRuntimeSignal(ctx.signalController.signal, signal)

	// Loop to handle transient reconnect rejections: when the session goes into
	// reconnecting before ever reaching ready, readyDeferred is rejected and a new
	// one is installed. Re-wait on the updated deferred until the session is truly
	// ready or a terminal condition (signal abort, session expired) is reached.
	for (;;) {
		try {
			// oxlint-disable-next-line no-await-in-loop
			await abortable(targetSignal, ctx.readyDeferred.promise)
			return
		} catch (error) {
			// If the combined signal fired, the session is terminated or the caller
			// cancelled — propagate immediately.
			if (targetSignal.aborted) {
				throw error
			}
			// Otherwise the rejection came from a transient reconnect. The effect
			// handler has already replaced ctx.readyDeferred with a fresh one.
			// Fall through and wait on it.
		}
	}
}

let assertResultStatus = function assertResultStatus(
	status: StatusIds_StatusCode,
	issues: unknown[]
): void {
	assert.strictEqual(status, StatusIds_StatusCode.SUCCESS, new YDBError(status, issues as any[]))
}

let request = async function request(
	ctx: SessionFullCtx,
	reqId: bigint,
	requestPayload: SessionStreamRequest,
	requestSignal?: AbortSignal
): Promise<SessionResponse> {
	for (;;) {
		// oxlint-disable-next-line no-await-in-loop
		await waitReady(ctx, requestSignal)

		let deferred = ctx.requests.register(reqId)
		let streamSignal = createRuntimeSignal(ctx.signalController.signal, requestSignal)

		try {
			sendRequest(ctx, requestPayload)
			// oxlint-disable-next-line no-await-in-loop
			return await abortable(streamSignal, deferred.promise)
		} catch (error) {
			ctx.requests.delete(reqId)

			// Retryable: the stream dropped while waiting for a response.
			// Loop back to waitReady so the request is re-sent after reconnect.
			if (error instanceof SessionReconnectError) {
				continue
			}

			throw error
		} finally {
			ctx.requests.delete(reqId)
		}
	}
}

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

				// Always replace readyDeferred so callers that re-enter waitReady
				// after a SessionReconnectError will block until the session is
				// truly ready again — not just see the already-resolved promise
				// from the previous ready state.
				ctx.readyDeferred.reject(new Error('Session reconnecting'))
				ctx.readyDeferred = createDeferred<void>()

				ctx.timerRetryBackoff = clearTimer(ctx.timerRetryBackoff)
				ctx.timerRetryBackoff = setTimeout(() => {
					ctx.timerRetryBackoff = null
					runtime.dispatch({ type: 'session.timer.retry_backoff_elapsed' })
				}, ctx.options.retryBackoff ?? 30)
			},
			'session.effect.timer.schedule_recovery_window': (ctx, _effect, runtime) => {
				if (ctx.timerRecoveryWindow) {
					return
				}

				ctx.timerRecoveryWindow = clearTimer(ctx.timerRecoveryWindow)
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
				dbg.log('restoring runtime after reconnect')
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

	return {
		runtime: machineRuntime,
		get sessionId(): bigint | null {
			return machineRuntime.ctx.sessionId
		},
		get status(): SessionStatus {
			return machineRuntime.state
		},
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
		async createSemaphore(
			name: string,
			createOptions: CreateSemaphoreOptions,
			signal?: AbortSignal
		): Promise<void> {
			let ctx = sessionCtx()
			let reqId = ctx.requests.nextReqId()
			let response = await request(
				ctx,
				reqId,
				{
					request: {
						case: 'createSemaphore',
						value: create(SessionRequest_CreateSemaphoreSchema, {
							reqId,
							name,
							limit:
								typeof createOptions.limit === 'bigint'
									? createOptions.limit
									: BigInt(createOptions.limit),
							data: createOptions.data ?? new Uint8Array(),
						}),
					},
				},
				signal
			)

			if (response.response.case !== 'createSemaphoreResult') {
				throw new Error('Unexpected response for create semaphore')
			}

			assertResultStatus(
				response.response.value.status as StatusIds_StatusCode,
				response.response.value.issues
			)
		},
		async updateSemaphore(name: string, data: Uint8Array, signal?: AbortSignal): Promise<void> {
			let ctx = sessionCtx()
			let reqId = ctx.requests.nextReqId()
			let response = await request(
				ctx,
				reqId,
				{
					request: {
						case: 'updateSemaphore',
						value: create(SessionRequest_UpdateSemaphoreSchema, {
							reqId,
							name,
							data,
						}),
					},
				},
				signal
			)

			if (response.response.case !== 'updateSemaphoreResult') {
				throw new Error('Unexpected response for update semaphore')
			}

			assertResultStatus(
				response.response.value.status as StatusIds_StatusCode,
				response.response.value.issues
			)
		},
		async deleteSemaphore(
			name: string,
			deleteOptions?: DeleteSemaphoreOptions,
			signal?: AbortSignal
		): Promise<void> {
			let ctx = sessionCtx()
			let reqId = ctx.requests.nextReqId()
			let response = await request(
				ctx,
				reqId,
				{
					request: {
						case: 'deleteSemaphore',
						value: create(SessionRequest_DeleteSemaphoreSchema, {
							reqId,
							name,
							force: deleteOptions?.force ?? false,
						}),
					},
				},
				signal
			)

			if (response.response.case !== 'deleteSemaphoreResult') {
				throw new Error('Unexpected response for delete semaphore')
			}

			assertResultStatus(
				response.response.value.status as StatusIds_StatusCode,
				response.response.value.issues
			)
		},
		async acquireSemaphore(
			name: string,
			acquireOptions?: AcquireSemaphoreOptions,
			signal?: AbortSignal
		): Promise<LeaseRuntime> {
			let ctx = sessionCtx()
			let normalized = {
				data: acquireOptions?.data ?? new Uint8Array(),
				count:
					acquireOptions?.count === undefined
						? 1n
						: typeof acquireOptions.count === 'bigint'
							? acquireOptions.count
							: BigInt(acquireOptions.count),
				ephemeral: acquireOptions?.ephemeral ?? false,
				waitTimeout:
					acquireOptions?.waitTimeout === undefined
						? 0n
						: typeof acquireOptions.waitTimeout === 'bigint'
							? acquireOptions.waitTimeout
							: BigInt(acquireOptions.waitTimeout),
			}
			let reqId = ctx.requests.nextReqId()
			let response = await request(
				ctx,
				reqId,
				{
					request: {
						case: 'acquireSemaphore',
						value: create(SessionRequest_AcquireSemaphoreSchema, {
							reqId,
							name,
							timeoutMillis: normalized.waitTimeout,
							count: normalized.count,
							data: normalized.data,
							ephemeral: normalized.ephemeral,
						}),
					},
				},
				signal
			)

			if (response.response.case !== 'acquireSemaphoreResult') {
				throw new Error('Unexpected response for acquire semaphore')
			}

			assertResultStatus(
				response.response.value.status as StatusIds_StatusCode,
				response.response.value.issues
			)

			if (!response.response.value.acquired) {
				throw new Error('Try acquire miss')
			}

			let leaseSignalController = new AbortController()
			let leaseSignal = AbortSignal.any([
				ctx.signalController.signal,
				leaseSignalController.signal,
			])
			let releaseDeferred = createDeferred<void>()
			let releaseStarted = false
			let releaseFinished = false

			return {
				get signal(): AbortSignal {
					return leaseSignal
				},
				async release(releaseSignal?: AbortSignal): Promise<void> {
					if (releaseFinished) {
						return
					}

					if (releaseStarted) {
						let targetSignal = createRuntimeSignal(leaseSignal, releaseSignal)
						await abortable(targetSignal, releaseDeferred.promise)
						return
					}

					releaseStarted = true

					let releaseCtx = sessionCtx()
					let releaseReqId = releaseCtx.requests.nextReqId()
					let releaseResponse: SessionResponse

					try {
						releaseResponse = await request(
							releaseCtx,
							releaseReqId,
							{
								request: {
									case: 'releaseSemaphore',
									value: create(SessionRequest_ReleaseSemaphoreSchema, {
										reqId: releaseReqId,
										name,
									}),
								},
							},
							releaseSignal
						)

						if (releaseResponse.response.case !== 'releaseSemaphoreResult') {
							throw new Error('Unexpected response for release semaphore')
						}

						assertResultStatus(
							releaseResponse.response.value.status as StatusIds_StatusCode,
							releaseResponse.response.value.issues
						)

						releaseFinished = true
						leaseSignalController.abort(new Error('Semaphore lease released'))
						releaseDeferred.resolve()
					} catch (error) {
						leaseSignalController.abort(error)
						releaseDeferred.reject(error)
						throw error
					}
				},
			}
		},
		async describeSemaphore(
			name: string,
			describeOptions?: DescribeSemaphoreOptions,
			signal?: AbortSignal
		): Promise<SemaphoreDescription> {
			let ctx = sessionCtx()
			let reqId = ctx.requests.nextReqId()
			let response = await request(
				ctx,
				reqId,
				{
					request: {
						case: 'describeSemaphore',
						value: create(SessionRequest_DescribeSemaphoreSchema, {
							reqId,
							name,
							includeOwners: describeOptions?.owners ?? false,
							includeWaiters: describeOptions?.waiters ?? false,
							watchData: false,
							watchOwners: false,
						}),
					},
				},
				signal
			)

			if (response.response.case !== 'describeSemaphoreResult') {
				throw new Error('Unexpected response for describe semaphore')
			}

			assertResultStatus(
				response.response.value.status as StatusIds_StatusCode,
				response.response.value.issues
			)

			let description = response.response.value.semaphoreDescription
			if (!description) {
				throw new Error('Missing semaphore description')
			}

			return {
				name: description.name,
				data: description.data,
				count: description.count,
				limit: description.limit,
				ephemeral: description.ephemeral,
				owners: description.owners.map((item) => ({
					data: item.data,
					count: item.count,
					orderId: item.orderId,
					sessionId: item.sessionId,
					timeoutMillis: item.timeoutMillis,
				})),
				waiters: description.waiters.map((item) => ({
					data: item.data,
					count: item.count,
					orderId: item.orderId,
					sessionId: item.sessionId,
					timeoutMillis: item.timeoutMillis,
				})),
			}
		},
		async *watchSemaphore(
			name: string,
			watchOptions?: WatchSemaphoreOptions,
			signal?: AbortSignal
		): AsyncIterable<SemaphoreDescription> {
			let ctx = sessionCtx()
			let signalController = new AbortController()
			let queue = new AsyncQueue<WatchChange>()
			let registration: WatchRegistration = {
				queue,
				reqId: 0n,
				signalController,
			}
			let previous = ctx.watchesByName.get(name)
			if (previous) {
				closeWatchRegistration(ctx, name, previous, new Error('Semaphore watch replaced'))
			}

			ctx.watchesByName.set(name, registration)

			let localSignal = signal
				? AbortSignal.any([signalController.signal, signal])
				: signalController.signal
			let watchSignal = createRuntimeSignal(ctx.signalController.signal, localSignal)

			let cleanup = function cleanup(reason: unknown): void {
				closeWatchRegistration(sessionCtx(), name, registration, reason)
			}

			let updateWatchRegistration = function updateWatchRegistration(reqId: bigint): void {
				let active = sessionCtx().watchesByName.get(name)
				if (active !== registration) {
					return
				}

				if (registration.reqId !== 0n) {
					sessionCtx().watchesByReqId.delete(registration.reqId)
				}

				registration.reqId = reqId
				sessionCtx().watchesByReqId.set(reqId, { name, queue })
			}

			let readDescription = async function readDescription(): Promise<SemaphoreDescription> {
				let active = sessionCtx().watchesByName.get(name)
				if (active !== registration) {
					throw new Error('Semaphore watch registration is inactive')
				}

				let reqId = sessionCtx().requests.nextReqId()
				let response = await request(
					sessionCtx(),
					reqId,
					{
						request: {
							case: 'describeSemaphore',
							value: create(SessionRequest_DescribeSemaphoreSchema, {
								reqId,
								name,
								includeOwners: watchOptions?.owners ?? false,
								includeWaiters: watchOptions?.waiters ?? false,
								watchData: watchOptions?.data ?? false,
								watchOwners: watchOptions?.owners ?? false,
							}),
						},
					},
					watchSignal
				)

				if (response.response.case !== 'describeSemaphoreResult') {
					throw new Error('Unexpected response for describe semaphore watch')
				}

				assertResultStatus(
					response.response.value.status as StatusIds_StatusCode,
					response.response.value.issues
				)

				let description = response.response.value.semaphoreDescription
				if (!description) {
					throw new Error('Missing semaphore description')
				}

				if (response.response.value.watchAdded) {
					updateWatchRegistration(reqId)
				}

				return {
					name: description.name,
					data: description.data,
					count: description.count,
					limit: description.limit,
					ephemeral: description.ephemeral,
					owners: description.owners.map((item) => ({
						data: item.data,
						count: item.count,
						orderId: item.orderId,
						sessionId: item.sessionId,
						timeoutMillis: item.timeoutMillis,
					})),
					waiters: description.waiters.map((item) => ({
						data: item.data,
						count: item.count,
						orderId: item.orderId,
						sessionId: item.sessionId,
						timeoutMillis: item.timeoutMillis,
					})),
				}
			}

			try {
				yield await readDescription()

				for await (let _change of queue) {
					if (watchSignal.aborted) {
						throw watchSignal.reason
					}

					yield await abortable(watchSignal, readDescription())
				}
			} finally {
				cleanup(new Error('Semaphore watch closed'))
			}
		},
	}
}
