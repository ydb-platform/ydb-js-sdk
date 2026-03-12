import { create } from '@bufbuild/protobuf'
import { abortable } from '@ydbjs/abortable'
import {
	SessionRequest_AcquireSemaphoreSchema,
	SessionRequest_CreateSemaphoreSchema,
	SessionRequest_DeleteSemaphoreSchema,
	SessionRequest_DescribeSemaphoreSchema,
	SessionRequest_ReleaseSemaphoreSchema,
	SessionRequest_UpdateSemaphoreSchema,
	type SessionResponse,
} from '@ydbjs/api/coordination'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { YDBError } from '@ydbjs/error'
import { AsyncQueue } from '@ydbjs/fsm/queue'
import * as assert from 'node:assert'

import type { CoordinationSessionOptions } from './session-options.js'
import {
	type Deferred,
	SessionReconnectError,
	type SessionRequestRegistry,
	createDeferred,
} from './session-registry.js'
import {
	type CoordinationSessionClient,
	type SessionStreamRequest,
	type WatchChange,
	type WatchRegistration,
	sendRequest,
} from './session-stream.js'

import type {
	AcquireSemaphoreOptions,
	CreateSemaphoreOptions,
	DeleteSemaphoreOptions,
	DescribeSemaphoreOptions,
	LeaseRuntime,
	SemaphoreDescription,
	SemaphoreRuntime,
	UpdateSemaphoreOptions,
	WatchSemaphoreOptions,
} from './semaphore-runtime.js'

// ── context shape ──────────────────────────────────────────────────────────────

// Structural type: the subset of the merged runtime context that semaphore
// operations need.  SessionFullCtx in session-runtime.ts satisfies this via
// structural compatibility — no import of SessionFullCtx is needed here.
// Fields mirror SessionEnv + SessionCtx; only the ones actually accessed are
// listed, but StreamCtx fields are included so sendRequest() can be called
// without a cast.
export type OperationsCtx = {
	// From SessionEnv — stream I/O
	client: CoordinationSessionClient
	options: CoordinationSessionOptions
	signal: AbortSignal | undefined
	streamInput: AsyncQueue<SessionStreamRequest> | null
	streamAbortController: AbortController | null
	streamIngest: AsyncDisposable | null
	// From SessionEnv — request tracking
	signalController: AbortController
	requests: SessionRequestRegistry
	readyDeferred: Deferred<void>
	// From SessionEnv — watch tracking
	watchesByName: Map<string, WatchRegistration>
	watchesByReqId: Map<bigint, { name: string; queue: AsyncQueue<WatchChange> }>
	// From SessionCtx
	sessionId: bigint | null
}

// ── local helpers ──────────────────────────────────────────────────────────────

let createRuntimeSignal = function createRuntimeSignal(
	runtimeSignal: AbortSignal,
	externalSignal?: AbortSignal
): AbortSignal {
	if (!externalSignal) {
		return runtimeSignal
	}

	return AbortSignal.any([runtimeSignal, externalSignal])
}

let assertResultStatus = function assertResultStatus(
	status: StatusIds_StatusCode,
	issues: unknown[]
): void {
	assert.strictEqual(status, StatusIds_StatusCode.SUCCESS, new YDBError(status, issues as any[]))
}

// Block until the session reaches ready state.  Loops on SessionReconnectError
// so that transient reconnects before the first ready do not surface to callers.
let waitReady = async function waitReady(ctx: OperationsCtx, signal?: AbortSignal): Promise<void> {
	let targetSignal = createRuntimeSignal(ctx.signalController.signal, signal)

	// Loop to handle transient reconnect rejections: when the session goes into
	// reconnecting before ever reaching ready (or re-entering reconnecting from
	// ready), readyDeferred is rejected and a new one is installed.  Re-wait on
	// the updated deferred until the session is truly ready or a terminal
	// condition (signal abort, session expired) is reached.
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
			// Otherwise the rejection came from a transient reconnect.  The effect
			// handler has already replaced ctx.readyDeferred with a fresh one.
			// Fall through and wait on it.
		}
	}
}

// Send a request on the stream and wait for the matching response.  Retries
// transparently when the session reconnects mid-flight.
let request = async function request(
	ctx: OperationsCtx,
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

// ── watch helpers ──────────────────────────────────────────────────────────────

let closeWatchRegistration = function closeWatchRegistration(
	ctx: OperationsCtx,
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

// ── description mapper ─────────────────────────────────────────────────────────

type RawSemaphoreDescription = NonNullable<
	Extract<
		SessionResponse['response'],
		{ case: 'describeSemaphoreResult' }
	>['value']['semaphoreDescription']
>

let mapDescription = function mapDescription(raw: RawSemaphoreDescription): SemaphoreDescription {
	return {
		name: raw.name,
		data: raw.data,
		count: raw.count,
		limit: raw.limit,
		ephemeral: raw.ephemeral,
		owners: raw.owners.map((item) => ({
			data: item.data,
			count: item.count,
			orderId: item.orderId,
			sessionId: item.sessionId,
			timeoutMillis: item.timeoutMillis,
		})),
		waiters: raw.waiters.map((item) => ({
			data: item.data,
			count: item.count,
			orderId: item.orderId,
			sessionId: item.sessionId,
			timeoutMillis: item.timeoutMillis,
		})),
	}
}

// ── public factory ─────────────────────────────────────────────────────────────

// Create the SemaphoreRuntime implementation.  sessionCtx is a function rather
// than a plain value because the context object may be replaced on reconnect
// (e.g. readyDeferred is swapped out) and inner closures need the latest ref.
export let createSemaphoreOperations = function createSemaphoreOperations(
	sessionCtx: () => OperationsCtx
): SemaphoreRuntime {
	return {
		get signal(): AbortSignal {
			return sessionCtx().signalController.signal
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
				throw new Error('Unexpected response for createSemaphore')
			}

			assertResultStatus(
				response.response.value.status as StatusIds_StatusCode,
				response.response.value.issues
			)
		},

		async updateSemaphore(
			name: string,
			updateOptions: UpdateSemaphoreOptions,
			signal?: AbortSignal
		): Promise<void> {
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
							data: updateOptions.data ?? new Uint8Array(),
						}),
					},
				},
				signal
			)

			if (response.response.case !== 'updateSemaphoreResult') {
				throw new Error('Unexpected response for updateSemaphore')
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
				throw new Error('Unexpected response for deleteSemaphore')
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
			let count =
				acquireOptions?.count === undefined
					? 1n
					: typeof acquireOptions.count === 'bigint'
						? acquireOptions.count
						: BigInt(acquireOptions.count)
			let waitTimeout =
				acquireOptions?.waitTimeout === undefined
					? 0n
					: typeof acquireOptions.waitTimeout === 'bigint'
						? acquireOptions.waitTimeout
						: BigInt(acquireOptions.waitTimeout)

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
							timeoutMillis: waitTimeout,
							count,
							data: acquireOptions?.data ?? new Uint8Array(),
							ephemeral: acquireOptions?.ephemeral ?? false,
						}),
					},
				},
				signal
			)

			if (response.response.case !== 'acquireSemaphoreResult') {
				throw new Error('Unexpected response for acquireSemaphore')
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
				sessionCtx().signalController.signal,
				leaseSignalController.signal,
			])
			let releaseDeferred = createDeferred<void>()
			let releaseStarted = false
			let releaseFinished = false

			let leaseRuntime: LeaseRuntime = {
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

					try {
						let releaseResponse = await request(
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
							throw new Error('Unexpected response for releaseSemaphore')
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

			return leaseRuntime
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
				throw new Error('Unexpected response for describeSemaphore')
			}

			assertResultStatus(
				response.response.value.status as StatusIds_StatusCode,
				response.response.value.issues
			)

			let description = response.response.value.semaphoreDescription
			if (!description) {
				throw new Error('Missing semaphore description in describeSemaphore result')
			}

			return mapDescription(description)
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

			// Replace any pre-existing watch for this semaphore name.
			let previous = ctx.watchesByName.get(name)
			if (previous) {
				closeWatchRegistration(ctx, name, previous, new Error('Semaphore watch replaced'))
			}

			ctx.watchesByName.set(name, registration)

			let localSignal = signal
				? AbortSignal.any([signalController.signal, signal])
				: signalController.signal
			let watchSignal = createRuntimeSignal(sessionCtx().signalController.signal, localSignal)

			// Update the reqId slot after each describe-with-watch call so the
			// ingest loop can route describeSemaphoreChanged messages to this queue.
			let updateWatchRegistration = function updateWatchRegistration(reqId: bigint): void {
				let current = sessionCtx()
				let active = current.watchesByName.get(name)
				if (active !== registration) {
					return
				}

				if (registration.reqId !== 0n) {
					current.watchesByReqId.delete(registration.reqId)
				}

				registration.reqId = reqId
				current.watchesByReqId.set(reqId, { name, queue })
			}

			// Fetch the current description and (re-)register the server-side watch.
			// Called once on entry and again after each reconnect notification.
			let readDescription = async function readDescription(): Promise<SemaphoreDescription> {
				let current = sessionCtx()
				let active = current.watchesByName.get(name)
				if (active !== registration) {
					throw new Error('Semaphore watch registration is no longer active')
				}

				let reqId = current.requests.nextReqId()
				let response = await request(
					current,
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
					throw new Error('Unexpected response for describeSemaphore (watch)')
				}

				assertResultStatus(
					response.response.value.status as StatusIds_StatusCode,
					response.response.value.issues
				)

				let description = response.response.value.semaphoreDescription
				if (!description) {
					throw new Error('Missing semaphore description in watch result')
				}

				if (response.response.value.watchAdded) {
					updateWatchRegistration(reqId)
				}

				return mapDescription(description)
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
				closeWatchRegistration(
					sessionCtx(),
					name,
					registration,
					new Error('Semaphore watch closed')
				)
			}
		},
	}
}
