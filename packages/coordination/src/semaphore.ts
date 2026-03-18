import { create } from '@bufbuild/protobuf'
import { abortable, linkSignals } from '@ydbjs/abortable'
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
import { loggers } from '@ydbjs/debug'

import { YDBError } from '@ydbjs/error'
import * as assert from 'node:assert'

import { LeaseReleasedError, TryAcquireMissError, isTryAcquireMiss } from './errors.js'
import type { SessionTransport, StreamEnvelope } from './runtime/session-transport.js'

let dbg = loggers.coordination.extend('semaphore')

let assertResultStatus = function assertResultStatus(
	status: StatusIds_StatusCode,
	issues: unknown[]
): void {
	assert.strictEqual(status, StatusIds_StatusCode.SUCCESS, new YDBError(status, issues as any[]))
}

let maxUint64 = 2n ** 64n - 1n
let emptyBytes = new Uint8Array()

// MAX_UINT64 tells the server to keep the acquire request queued indefinitely.
// A value of 0 means "return immediately if not available" (tryAcquire).
let waitIndefinitely = maxUint64

export interface CreateSemaphoreOptions {
	limit: number | bigint
	data?: Uint8Array
}

export interface DeleteSemaphoreOptions {
	force?: boolean
}

export interface AcquireSemaphoreOptions {
	count?: number | bigint
	data?: Uint8Array
	ephemeral?: boolean
	waitTimeout?: number | bigint
}

export interface DescribeSemaphoreOptions {
	owners?: boolean
	waiters?: boolean
}

export interface WatchSemaphoreOptions extends DescribeSemaphoreOptions {
	data?: boolean
}

export interface SemaphoreSessionDescription {
	data: Uint8Array
	count: bigint
	orderId: bigint
	sessionId: bigint
	timeoutMillis: bigint
}

export interface SemaphoreDescription {
	name: string
	data: Uint8Array
	count: bigint
	limit: bigint
	ephemeral: boolean
	owners?: SemaphoreSessionDescription[]
	waiters?: SemaphoreSessionDescription[]
}

export class Lease implements AsyncDisposable {
	#ac = new AbortController()
	#semaphore: Semaphore

	constructor(semaphore: Semaphore) {
		this.#semaphore = semaphore
	}

	get name(): string {
		return this.#semaphore.name
	}

	get signal(): AbortSignal {
		return this.#ac.signal
	}

	async release(signal?: AbortSignal): Promise<void> {
		if (this.#ac.signal.aborted) {
			return
		}

		try {
			await this.#semaphore.release(signal)
			this.#ac.abort(new LeaseReleasedError())
		} catch (error) {
			this.#ac.abort(error)
			throw error
		}
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.release()
	}
}

export class Semaphore {
	#name: string
	#transport: SessionTransport
	#sessionSignal: AbortSignal

	constructor(name: string, transport: SessionTransport, sessionSignal: AbortSignal) {
		this.#name = name
		this.#transport = transport
		this.#sessionSignal = sessionSignal
	}

	get name(): string {
		return this.#name
	}

	async create(options: CreateSemaphoreOptions, signal?: AbortSignal): Promise<void> {
		dbg.log('creating %s (limit=%s)', this.#name, options.limit)

		let response = await this.#transport.call(
			(reqId) => ({
				request: {
					case: 'createSemaphore',
					value: create(SessionRequest_CreateSemaphoreSchema, {
						reqId,
						name: this.#name,
						limit: toBigInt(options.limit),
						data: options.data ?? emptyBytes,
					}),
				},
			}),
			signal
		)

		if (response.response.case !== 'createSemaphoreResult') {
			throw new Error('Unexpected response for createSemaphore')
		}

		assertResultStatus(
			response.response.value.status as StatusIds_StatusCode,
			response.response.value.issues
		)
	}

	async update(data: Uint8Array, signal?: AbortSignal): Promise<void> {
		dbg.log('updating data on %s (%d bytes)', this.#name, data.byteLength)

		let response = await this.#transport.call(
			(reqId) => ({
				request: {
					case: 'updateSemaphore',
					value: create(SessionRequest_UpdateSemaphoreSchema, {
						reqId,
						name: this.#name,
						data,
					}),
				},
			}),
			signal
		)

		if (response.response.case !== 'updateSemaphoreResult') {
			throw new Error('Unexpected response for updateSemaphore')
		}

		assertResultStatus(
			response.response.value.status as StatusIds_StatusCode,
			response.response.value.issues
		)
	}

	async delete(options?: DeleteSemaphoreOptions, signal?: AbortSignal): Promise<void> {
		dbg.log('deleting %s%s', this.#name, options?.force ? ' (force)' : '')

		let response = await this.#transport.call(
			(reqId) => ({
				request: {
					case: 'deleteSemaphore',
					value: create(SessionRequest_DeleteSemaphoreSchema, {
						reqId,
						name: this.#name,
						force: options?.force ?? false,
					}),
				},
			}),
			signal
		)

		if (response.response.case !== 'deleteSemaphoreResult') {
			throw new Error('Unexpected response for deleteSemaphore')
		}

		assertResultStatus(
			response.response.value.status as StatusIds_StatusCode,
			response.response.value.issues
		)
	}

	async acquire(options?: AcquireSemaphoreOptions, signal?: AbortSignal): Promise<Lease> {
		let count = toBigInt(options?.count ?? 1)
		let waitTimeout = toBigInt(options?.waitTimeout ?? waitIndefinitely)
		let data = options?.data ?? emptyBytes
		let ephemeral = options?.ephemeral ?? false

		dbg.log('waiting to acquire %s (count=%s)', this.#name, count)

		let buildEnvelope = (reqId: bigint): StreamEnvelope => ({
			request: {
				case: 'acquireSemaphore',
				value: create(SessionRequest_AcquireSemaphoreSchema, {
					reqId,
					name: this.#name,
					timeoutMillis: waitTimeout,
					count,
					data,
					ephemeral,
				}),
			},
		})

		// The initial request allocates a reqId that is pinned for the entire
		// acquire flow — the server uses it to identify the waiter slot.
		let pinnedReqId!: bigint
		let response = await this.#transport.call((reqId) => {
			pinnedReqId = reqId
			return buildEnvelope(reqId)
		}, signal)

		// The server may respond with acquireSemaphorePending before the final
		// result. We keep waiting with the same pinned reqId — on reconnect
		// the full request is re-sent because the server lost the waiter state.
		while (response.response.case === 'acquireSemaphorePending') {
			// oxlint-disable-next-line no-await-in-loop
			response = await this.#transport.callPinned(
				pinnedReqId,
				() => this.#transport.send(buildEnvelope(pinnedReqId)),
				signal
			)
		}

		if (response.response.case !== 'acquireSemaphoreResult') {
			throw new Error('Unexpected response for acquireSemaphore')
		}

		assertResultStatus(
			response.response.value.status as StatusIds_StatusCode,
			response.response.value.issues
		)

		if (!response.response.value.acquired) {
			throw new TryAcquireMissError()
		}

		dbg.log('acquired %s', this.#name)

		return new Lease(this)
	}

	async release(signal?: AbortSignal): Promise<void> {
		dbg.log('releasing %s', this.#name)

		let response = await this.#transport.call(
			(reqId) => ({
				request: {
					case: 'releaseSemaphore',
					value: create(SessionRequest_ReleaseSemaphoreSchema, {
						reqId,
						name: this.#name,
					}),
				},
			}),
			signal
		)

		if (response.response.case !== 'releaseSemaphoreResult') {
			throw new Error('Unexpected response for releaseSemaphore')
		}

		assertResultStatus(
			response.response.value.status as StatusIds_StatusCode,
			response.response.value.issues
		)
	}

	async tryAcquire(
		options?: AcquireSemaphoreOptions,
		signal?: AbortSignal
	): Promise<Lease | null> {
		dbg.log('trying to acquire %s without waiting (count=%s)', this.#name, options?.count ?? 1)

		try {
			return await this.acquire({ ...options, waitTimeout: 0n }, signal)
		} catch (error) {
			if (isTryAcquireMiss(error)) {
				dbg.log('%s is already held, skipping', this.#name)
				return null
			}

			throw error
		}
	}

	async describe(
		options?: DescribeSemaphoreOptions,
		signal?: AbortSignal
	): Promise<SemaphoreDescription> {
		let response = await this.#transport.call(
			(reqId) => ({
				request: {
					case: 'describeSemaphore',
					value: create(SessionRequest_DescribeSemaphoreSchema, {
						reqId,
						name: this.#name,
						includeOwners: options?.owners ?? false,
						includeWaiters: options?.waiters ?? false,
						watchData: false,
						watchOwners: false,
					}),
				},
			}),
			signal
		)

		if (response.response.case !== 'describeSemaphoreResult') {
			throw new Error('Unexpected response for describeSemaphore')
		}

		assertResultStatus(
			response.response.value.status as StatusIds_StatusCode,
			response.response.value.issues
		)

		let raw = response.response.value.semaphoreDescription
		if (!raw) {
			throw new Error('Missing semaphore description in response')
		}

		return mapDescription(raw)
	}

	async *watch(
		options?: WatchSemaphoreOptions,
		signal?: AbortSignal
	): AsyncIterable<SemaphoreDescription> {
		using subscription = this.#transport.watch(this.#name)
		using combined = linkSignals(this.#sessionSignal, signal)

		let describeAndWatch = async (): Promise<SemaphoreDescription> => {
			let watchReqId!: bigint

			let response = await this.#transport.call((reqId) => {
				watchReqId = reqId
				return {
					request: {
						case: 'describeSemaphore',
						value: create(SessionRequest_DescribeSemaphoreSchema, {
							reqId,
							name: this.#name,
							includeOwners: options?.owners ?? false,
							includeWaiters: options?.waiters ?? false,
							watchData: options?.data ?? false,
							watchOwners: options?.owners ?? false,
						}),
					},
				}
			}, combined.signal)

			if (response.response.case !== 'describeSemaphoreResult') {
				throw new Error('Unexpected response for describeSemaphore (watch)')
			}

			assertResultStatus(
				response.response.value.status as StatusIds_StatusCode,
				response.response.value.issues
			)

			let raw = response.response.value.semaphoreDescription
			if (!raw) {
				throw new Error('Missing semaphore description in watch result')
			}

			if (response.response.value.watchAdded) {
				subscription.updateReqId(watchReqId)
			}

			return mapDescription(raw)
		}

		yield await describeAndWatch()

		for await (let _change of subscription.queue) {
			combined.signal.throwIfAborted()
			yield await abortable(combined.signal, describeAndWatch())
		}
	}
}

let toBigInt = function toBigInt(value: number | bigint): bigint {
	if (typeof value === 'bigint') {
		return value
	}

	if (value === Infinity) {
		return maxUint64
	}

	return BigInt(value)
}

type RawDescription = NonNullable<
	Extract<
		SessionResponse['response'],
		{ case: 'describeSemaphoreResult' }
	>['value']['semaphoreDescription']
>

let mapDescription = function mapDescription(raw: RawDescription): SemaphoreDescription {
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
