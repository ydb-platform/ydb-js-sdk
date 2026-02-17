import { EventEmitter } from 'node:events'

import { create } from '@bufbuild/protobuf'
import { abortable } from '@ydbjs/abortable'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import {
	CoordinationServiceDefinition,
	type SemaphoreDescription,
	type SessionRequest,
	SessionRequestSchema,
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
	type SessionResponse_AcquireSemaphoreResult,
	type SessionResponse_CreateSemaphoreResult,
	type SessionResponse_DeleteSemaphoreResult,
	type SessionResponse_DescribeSemaphoreResult,
	type SessionResponse_ReleaseSemaphoreResult,
	type SessionResponse_UpdateSemaphoreResult,
} from '@ydbjs/api/coordination'
import type { Driver } from '@ydbjs/core'
import { loggers } from '@ydbjs/debug'
import { YDBError } from '@ydbjs/error'
import { retry } from '@ydbjs/retry'
import { backoff, combine, jitter } from '@ydbjs/retry/strategy'

import { BidirectionalStream } from './stream.js'
import type { Lock } from './semaphore.js'
import { SemaphoreLock } from './semaphore.js'
import type { SessionOptions } from './index.js'

let dbg = loggers.driver.extend('coordination').extend('session')

// Timeout for waiting SessionStarted response during session initialization
// Retry loop will handle reconnection if this timeout is exceeded
let SESSION_START_TIMEOUT_MS = 5000

// Maximum value for uint64 in protobuf
let MAX_UINT64 = 2n ** 64n - 1n

/**
 * Symbol for accessing test-only methods on CoordinationSession
 * @internal This is for testing purposes only
 */
export const TEST_ONLY = Symbol('TEST_ONLY')

/**
 * Converts a number to bigint, handling Infinity as MAX_UINT64
 */
function toBigInt(value: number): bigint {
	if (value === Infinity) {
		return MAX_UINT64
	}
	return BigInt(Math.floor(value))
}

/**
 * Result type for session responses
 */
type SessionResult =
	| SessionResponse_AcquireSemaphoreResult
	| SessionResponse_ReleaseSemaphoreResult
	| SessionResponse_CreateSemaphoreResult
	| SessionResponse_UpdateSemaphoreResult
	| SessionResponse_DeleteSemaphoreResult
	| SessionResponse_DescribeSemaphoreResult

/**
 * Options for acquiring a semaphore
 */
export interface AcquireSemaphoreOptions {
	/**
	 * Number of tokens to acquire (default: 1)
	 */
	count?: number

	/**
	 * Timeout in milliseconds after which operation will fail if it's still waiting in the waiters queue.
	 * Use Infinity for no timeout
	 */
	timeoutMillis?: number

	/**
	 * User-defined binary data that may be attached to the operation
	 */
	data?: Uint8Array

	/**
	 * Ephemeral semaphores are created with the first acquire operation
	 * and automatically deleted with the last release operation
	 */
	ephemeral?: boolean
}

/**
 * Options for creating a semaphore
 */
export interface CreateSemaphoreOptions {
	/**
	 * Number of tokens that may be acquired by sessions
	 */
	limit: number

	/**
	 * User-defined data that is attached to the semaphore
	 */
	data?: Uint8Array
}

/**
 * Options for deleting a semaphore
 */
export interface DeleteSemaphoreOptions {
	/**
	 * Will delete semaphore even if currently acquired by sessions
	 */
	force?: boolean
}

/**
 * Options for describing a semaphore
 */
export interface DescribeSemaphoreOptions {
	/**
	 * Include owners list in the response
	 */
	includeOwners?: boolean

	/**
	 * Include waiters list in the response
	 */
	includeWaiters?: boolean

	/**
	 * Watch for changes in semaphore data
	 */
	watchData?: boolean

	/**
	 * Watch for changes in semaphore owners
	 */
	watchOwners?: boolean
}

/**
 * Options for watching a semaphore
 */
export interface WatchOptions {
	/**
	 * Watch for changes in semaphore data
	 */
	data?: boolean

	/**
	 * Watch for changes in semaphore owners
	 */
	owners?: boolean

	/**
	 * Include owners list in each update
	 * (automatically enabled if owners is true)
	 */
	includeOwners?: boolean

	/**
	 * Include waiters list in each update
	 */
	includeWaiters?: boolean
}

/**
 * Result of describing a semaphore
 */
export interface DescribeSemaphoreResult {
	/**
	 * Semaphore description
	 */
	description: SemaphoreDescription | undefined

	/**
	 * True if watch was successfully added
	 */
	watchAdded: boolean
}

/**
 * Event emitted when a watched semaphore changes
 */
export interface SemaphoreChangedEvent {
	/**
	 * Semaphore name
	 */
	name: string

	/**
	 * True if semaphore data changed
	 */
	dataChanged: boolean

	/**
	 * True if semaphore owners changed
	 */
	ownersChanged: boolean
}

/**
 * Event emitted when session expires
 */
export interface SessionExpiredEvent {
	/**
	 * Session ID that expired
	 */
	sessionId: bigint

	/**
	 * Timestamp when expiration was detected
	 */
	timestamp: Date
}

/**
 * Event names for CoordinationSession
 */
export const CoordinationSessionEvents = {
	/**
	 * Emitted when a watched semaphore changes
	 */
	SEMAPHORE_CHANGED: 'semaphoreChanged',

	/**
	 * Emitted when session expires and new session is created.
	 *
	 * Important: When new session is created, all acquired semaphores are automatically released
	 * by the server. The client must re-acquire any needed semaphores after receiving this event.
	 */
	SESSION_EXPIRED: 'sessionExpired',
} as const

/**
 * Coordination session for working with semaphores
 *
 * Provides methods for acquiring, releasing, creating, updating, deleting,
 * and describing semaphores within a coordination node.
 *
 * Supports automatic session recovery via reconnection with the same session ID.
 * Responds to server ping messages to maintain connection liveness.
 *
 * Emits 'semaphoreChanged' events when watched semaphores change.
 * Emits 'sessionExpired' events when session expires and new session is created.
 *
 * Implements AsyncDisposable for automatic cleanup with `using` keyword.
 *
 * @example
 * ```typescript
 * // Manual session management
 * let session = await client.session('/local/node')
 * await session.close()
 *
 * // Automatic cleanup with using keyword
 * await using session = await client.session('/local/node')
 * // session is automatically closed when leaving scope
 *
 * // Watch for semaphore changes
 * session.on('semaphoreChanged', (event) => {
 *   console.log(`Semaphore ${event.name} changed:`, event)
 * })
 *
 * // Watch for session expiration
 * session.on('sessionExpired', (event) => {
 *   console.log(`Session ${event.sessionId} expired at ${event.timestamp}`)
 * })
 *
 * // Describe with watch
 * await session.describe('my-lock', {
 *   watchData: true,
 *   watchOwners: true
 * })
 * ```
 */
export class CoordinationSession
	extends EventEmitter
	implements AsyncDisposable
{
	#driver: Driver
	#path: string
	#recoveryWindowMs: number
	#description: string
	#sessionId: bigint = 0n
	#reqIdCounter: bigint = 0n
	#seqNo: bigint = 0n

	// Resolve functions for waiting SessionStarted and SessionStopped
	#sessionStartedResolve: (() => void) | null = null
	#sessionStoppedResolve: (() => void) | null = null

	// Bidirectional stream handler
	#stream: BidirectionalStream<SessionRequest, SessionResponse, SessionResult>

	// Reconnection state
	#closed: boolean = false

	// Promise that resolves when first session is started
	// eslint-disable-next-line no-unused-private-class-members
	#firstSessionStarted: Promise<void>
	#firstSessionStartedResolve: (() => void) | null = null

	// Map of reqId to semaphore name for watch tracking
	#watchedSemaphores: Map<bigint, string> = new Map()

	constructor(driver: Driver, path: string, options?: SessionOptions) {
		super()
		this.#driver = driver
		this.#path = path
		this.#recoveryWindowMs = options?.recoveryWindowMs ?? 30000
		this.#description = options?.description ?? ''

		this.#stream = new BidirectionalStream({
			onResponse: (response) => this.#handleResponse(response),
			extractReqId: (response) => this.#extractReqId(response),
			extractResult: (response) => this.#extractResult(response),
		})

		// Create promise that resolves on first SessionStarted
		this.#firstSessionStarted = new Promise<void>((resolve) => {
			this.#firstSessionStartedResolve = resolve
		})

		// Start connection loop immediately in background
		this.#connectionLoop().catch((error) => {
			dbg.log('connection loop failed: %O', error)
		})
	}

	/**
	 * Waits for the session to be ready (first connection established)
	 *
	 * This method is called internally by coordination client.
	 * Users should not need to call it directly.
	 */
	async ready(): Promise<void> {
		await this.#firstSessionStarted
	}

	/**
	 * Handles incoming responses
	 */
	#handleResponse(response: SessionResponse): void {
		dbg.log('received response: %s', response.response.case)

		switch (response.response.case) {
			case 'ping':
				// Server sent ping, respond with pong
				let opaque = response.response.value.opaque
				dbg.log('received ping with opaque: %s', opaque)
				let pongRequest = create(SessionRequestSchema, {
					request: {
						case: 'pong',
						value: create(SessionRequest_PingPongSchema, {
							opaque,
						}),
					},
				})
				this.#stream.send(pongRequest)
				dbg.log('sent pong with opaque: %s', opaque)
				break

			case 'failure': {
				let failure = response.response.value
				dbg.log('session failure: status=%s', failure.status)

				// If session is expired or not accessible, reset session ID to create a new session on reconnect
				if (
					failure.status === StatusIds_StatusCode.SESSION_EXPIRED ||
					failure.status === StatusIds_StatusCode.BAD_SESSION
				) {
					let expiredSessionId = this.#sessionId
					dbg.log(
						'session is expired or not accessible, resetting session_id from %s to 0 to recreate session',
						expiredSessionId
					)
					this.#sessionId = 0n
					this.#watchedSemaphores.clear()

					// Emit sessionExpired event to notify user
					let event: SessionExpiredEvent = {
						sessionId: expiredSessionId,
						timestamp: new Date(),
					}
					this.emit(CoordinationSessionEvents.SESSION_EXPIRED, event)
				}

				// Disconnect stream to trigger reconnection
				this.#stream.disconnect()
				break
			}

			case 'sessionStarted':
				this.#sessionId = response.response.value.sessionId
				dbg.log('session started with id: %s', this.#sessionId)
				// Resolve the sessionStarted promise
				if (this.#sessionStartedResolve) {
					this.#sessionStartedResolve()
					this.#sessionStartedResolve = null
				}
				// Resolve the first session started promise (only once)
				if (this.#firstSessionStartedResolve) {
					this.#firstSessionStartedResolve()
					this.#firstSessionStartedResolve = null
				}
				break

			case 'sessionStopped':
				dbg.log(
					'session stopped: %s',
					response.response.value.sessionId
				)
				// Resolve the sessionStopped promise
				if (this.#sessionStoppedResolve) {
					this.#sessionStoppedResolve()
					this.#sessionStoppedResolve = null
				}
				break

			case 'acquireSemaphorePending':
				dbg.log(
					'acquire semaphore pending: reqId=%s',
					response.response.value.reqId
				)
				// Just a notification
				break

			case 'describeSemaphoreChanged': {
				let change = response.response.value
				dbg.log(
					'semaphore changed: reqId=%s, dataChanged=%s, ownersChanged=%s',
					change.reqId,
					change.dataChanged,
					change.ownersChanged
				)
				// Emit event with semaphore name if we're tracking this watch
				let name = this.#watchedSemaphores.get(change.reqId)
				if (name) {
					let event: SemaphoreChangedEvent = {
						name,
						dataChanged: change.dataChanged,
						ownersChanged: change.ownersChanged,
					}
					this.emit(
						CoordinationSessionEvents.SEMAPHORE_CHANGED,
						event
					)

					this.#watchedSemaphores.delete(change.reqId)
				}
				break
			}

			default:
				break
		}
	}

	/**
	 * Connection loop that maintains session and reconnects on errors
	 */
	async #connectionLoop(): Promise<void> {
		await retry(
			{
				// Always retry - we want infinite reconnection loop
				retry: true,
				// Infinite retry attempts for connection loop
				budget: Infinity,
				strategy: combine(backoff(50, 5000), jitter(50)),
				onRetry(ctx) {
					dbg.log(
						'retrying session connection, attempt %d, error: %O',
						ctx.attempt,
						ctx.error
					)
				},
			},
			async () => {
				if (this.#closed) {
					return
				}

				dbg.log('connection loop: starting session')
				await this.#startSession()

				await this.#stream.waitForDisconnect()
				dbg.log('connection loop: stream disconnected')

				// Throw error to trigger retry with backoff
				throw new Error('Stream disconnected, reconnecting')
			}
		)
		dbg.log('connection loop: exited')
	}

	/**
	 * Starts a new session or restores existing one
	 */
	async #startSession(): Promise<void> {
		dbg.log(
			'starting session for path: %s (sessionId: %s, seqNo: %s)',
			this.#path,
			this.#sessionId,
			this.#seqNo
		)

		await this.#driver.ready()

		let client = this.#driver.createClient(CoordinationServiceDefinition)

		let startRequest = create(SessionRequestSchema, {
			request: {
				case: 'sessionStart',
				value: create(SessionRequest_SessionStartSchema, {
					path: this.#path,
					sessionId: this.#sessionId,
					timeoutMillis: toBigInt(this.#recoveryWindowMs),
					description: this.#description,
					seqNo: this.#seqNo++,
				}),
			},
		})

		let sessionStartedReject: ((reason?: any) => void) | null = null
		let sessionStartedPromise = new Promise<void>((resolve, reject) => {
			this.#sessionStartedResolve = resolve
			sessionStartedReject = reject
		})

		// Start stream (will automatically retry pending requests on reconnection)
		this.#stream.start(
			(requests, signal) =>
				client.session(requests, signal ? { signal } : {}),
			startRequest
		)

		// Wait for SessionStarted response with timeout
		try {
			await abortable(
				AbortSignal.timeout(SESSION_START_TIMEOUT_MS),
				sessionStartedPromise
			)
		} catch (error) {
			// Reject the promise to prevent it from hanging on retry
			if (sessionStartedReject) {
				;(sessionStartedReject as (reason?: any) => void)(error)
			}

			// Disconnect stream on error to reset state for next start() attempt
			this.#stream.disconnect()

			// Convert AbortError to regular Error so retry mechanism can handle it
			// AbortError is not retryable by default, but session start timeout should be retried
			if (error instanceof Error && error.name === 'AbortError') {
				throw new Error(
					`Failed to start session: no SessionStarted response within ${SESSION_START_TIMEOUT_MS}ms`,
					{ cause: error }
				)
			}
			throw error
		} finally {
			this.#sessionStartedResolve = null
		}
	}

	/**
	 * Extracts request ID from response
	 */
	#extractReqId(response: SessionResponse): bigint | null {
		switch (response.response.case) {
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

	/**
	 * Extracts result from response and checks for errors
	 */
	#extractResult(response: SessionResponse): SessionResult | null {
		switch (response.response.case) {
			case 'acquireSemaphoreResult':
			case 'releaseSemaphoreResult':
			case 'createSemaphoreResult':
			case 'updateSemaphoreResult':
			case 'deleteSemaphoreResult':
			case 'describeSemaphoreResult': {
				let result = response.response.value
				if (result.status !== StatusIds_StatusCode.SUCCESS) {
					throw new YDBError(result.status, result.issues)
				}
				return result
			}

			default:
				return null
		}
	}

	/**
	 * Gets the next request ID
	 */
	#nextReqId(): bigint {
		return ++this.#reqIdCounter
	}

	/**
	 * Internal method to send acquire semaphore request
	 */
	async #makeAcquireRequest(
		name: string,
		options?: AcquireSemaphoreOptions,
		signal?: AbortSignal
	): Promise<SessionResponse_AcquireSemaphoreResult> {
		if (this.#closed) {
			throw new Error('Session is closed')
		}

		let reqId = this.#nextReqId()
		dbg.log('acquiring semaphore: %s (reqId: %s)', name, reqId)

		let request = create(SessionRequestSchema, {
			request: {
				case: 'acquireSemaphore',
				value: create(SessionRequest_AcquireSemaphoreSchema, {
					reqId,
					name,
					count: toBigInt(options?.count ?? 1),
					timeoutMillis: toBigInt(
						options?.timeoutMillis ?? this.#recoveryWindowMs
					),
					data: options?.data ?? new Uint8Array(),
					ephemeral: options?.ephemeral ?? false,
				}),
			},
		})

		return (await this.#stream.sendRequest(
			reqId,
			request,
			signal
		)) as SessionResponse_AcquireSemaphoreResult
	}

	/**
	 * Acquires a semaphore and returns a lock handle for use with `await using` keyword
	 *
	 * This method waits until the semaphore is acquired or the timeout expires.
	 * If the semaphore cannot be acquired within the timeout, it throws an error.
	 *
	 * @param name - Name of the semaphore to acquire
	 * @param options - Options for acquiring the semaphore
	 * @param signal - AbortSignal to timeout the operation
	 * @returns A Lock handle that automatically releases on disposal
	 * @throws {YDBError} If the operation fails or semaphore cannot be acquired within timeout
	 *
	 * @example
	 * ```typescript
	 * {
	 *   // Automatic release with using keyword
	 *   await using lock = await session.acquire('my-lock')
	 *   // Lock is guaranteed to be held here
	 *   // do work with lock
	 * }
	 * // lock is automatically released here
	 * ```
	 */
	async acquire(
		name: string,
		options?: AcquireSemaphoreOptions,
		signal?: AbortSignal
	): Promise<Lock> {
		let result = await this.#makeAcquireRequest(name, options, signal)

		if (!result.acquired) {
			throw new YDBError(StatusIds_StatusCode.TIMEOUT, [])
		}

		return new SemaphoreLock(this, name)
	}

	/**
	 * Tries to acquire a semaphore without blocking
	 *
	 * This method attempts to acquire the semaphore and returns null if it cannot be acquired.
	 *
	 * @param name - Name of the semaphore to acquire
	 * @param options - Options for acquiring the semaphore
	 * @param signal - AbortSignal to timeout the operation
	 * @returns A Lock handle if acquired, null otherwise
	 * @throws {YDBError} If the operation fails
	 *
	 * @example
	 * ```typescript
	 * {
	 *   await using lock = await session.tryAcquire('my-lock', { timeoutMillis: 1000 })
	 *   if (lock) {
	 *     // Lock was acquired, do work
	 *   } else {
	 *     // Lock was not acquired, handle gracefully
	 *     console.log('Could not acquire lock, skipping work')
	 *   }
	 * }
	 * // lock is automatically released here if it was acquired
	 * ```
	 */
	async tryAcquire(
		name: string,
		options?: AcquireSemaphoreOptions,
		signal?: AbortSignal
	): Promise<Lock | null> {
		let result = await this.#makeAcquireRequest(name, options, signal)

		if (!result.acquired) {
			return null
		}

		return new SemaphoreLock(this, name)
	}

	/**
	 * Releases a semaphore
	 *
	 * @param name - Name of the semaphore to release
	 * @param signal - AbortSignal to timeout the operation.
	 *   Useful for setting operation timeout during long reconnections.
	 *   Note: Aborting removes the request from retry queue, but if the request
	 *   was already sent to the server, it may still be processed.
	 * @returns True if released, false if not acquired
	 * @throws {YDBError} If the operation fails
	 */
	async release(name: string, signal?: AbortSignal): Promise<boolean> {
		if (this.#closed) {
			throw new Error('Session is closed')
		}

		let reqId = this.#nextReqId()
		dbg.log('releasing semaphore: %s (reqId: %s)', name, reqId)

		let request = create(SessionRequestSchema, {
			request: {
				case: 'releaseSemaphore',
				value: create(SessionRequest_ReleaseSemaphoreSchema, {
					reqId,
					name,
				}),
			},
		})

		let result = (await this.#stream.sendRequest(
			reqId,
			request,
			signal
		)) as SessionResponse_ReleaseSemaphoreResult
		return result.released
	}

	/**
	 * Creates a new semaphore
	 *
	 * @param name - Name of the semaphore to create
	 * @param options - Options for creating the semaphore
	 * @param signal - AbortSignal to timeout the operation.
	 *   Useful for setting operation timeout during long reconnections.
	 *   Note: Aborting removes the request from retry queue, but if the request
	 *   was already sent to the server, it may still be processed.
	 * @throws {YDBError} If the operation fails
	 */
	async create(
		name: string,
		options: CreateSemaphoreOptions,
		signal?: AbortSignal
	): Promise<void> {
		if (this.#closed) {
			throw new Error('Session is closed')
		}

		let reqId = this.#nextReqId()
		dbg.log('creating semaphore: %s (reqId: %s)', name, reqId)

		let request = create(SessionRequestSchema, {
			request: {
				case: 'createSemaphore',
				value: create(SessionRequest_CreateSemaphoreSchema, {
					reqId,
					name,
					limit: toBigInt(options.limit),
					data: options.data ?? new Uint8Array(),
				}),
			},
		})

		await this.#stream.sendRequest(reqId, request, signal)
	}

	/**
	 * Updates a semaphore's data
	 *
	 * @param name - Name of the semaphore to update
	 * @param data - User-defined data to attach to the semaphore
	 * @param signal - AbortSignal to timeout the operation.
	 *   Useful for setting operation timeout during long reconnections.
	 *   Note: Aborting removes the request from retry queue, but if the request
	 *   was already sent to the server, it may still be processed.
	 * @throws {YDBError} If the operation fails
	 */
	async update(
		name: string,
		data: Uint8Array,
		signal?: AbortSignal
	): Promise<void> {
		if (this.#closed) {
			throw new Error('Session is closed')
		}

		let reqId = this.#nextReqId()
		dbg.log('updating semaphore: %s (reqId: %s)', name, reqId)

		let request = create(SessionRequestSchema, {
			request: {
				case: 'updateSemaphore',
				value: create(SessionRequest_UpdateSemaphoreSchema, {
					reqId,
					name,
					data,
				}),
			},
		})

		await this.#stream.sendRequest(reqId, request, signal)
	}

	/**
	 * Deletes a semaphore
	 *
	 * @param name - Name of the semaphore to delete
	 * @param options - Options for deleting the semaphore
	 * @param signal - AbortSignal to timeout the operation.
	 *   Useful for setting operation timeout during long reconnections.
	 *   Note: Aborting removes the request from retry queue, but if the request
	 *   was already sent to the server, it may still be processed.
	 * @throws {YDBError} If the operation fails
	 */
	async delete(
		name: string,
		options?: DeleteSemaphoreOptions,
		signal?: AbortSignal
	): Promise<void> {
		if (this.#closed) {
			throw new Error('Session is closed')
		}

		let reqId = this.#nextReqId()
		dbg.log('deleting semaphore: %s (reqId: %s)', name, reqId)

		let request = create(SessionRequestSchema, {
			request: {
				case: 'deleteSemaphore',
				value: create(SessionRequest_DeleteSemaphoreSchema, {
					reqId,
					name,
					force: options?.force ?? false,
				}),
			},
		})

		await this.#stream.sendRequest(reqId, request, signal)
	}

	/**
	 * Describes a semaphore
	 *
	 * @param name - Name of the semaphore to describe
	 * @param options - Options for describing the semaphore
	 * @param signal - AbortSignal to timeout the operation.
	 *   Useful for setting operation timeout during long reconnections.
	 *   Note: Aborting removes the request from retry queue, but if the request
	 *   was already sent to the server, it may still be processed.
	 * @returns Semaphore description and watch status
	 * @throws {YDBError} If the operation fails
	 */
	async describe(
		name: string,
		options?: DescribeSemaphoreOptions,
		signal?: AbortSignal
	): Promise<DescribeSemaphoreResult> {
		if (this.#closed) {
			throw new Error('Session is closed')
		}

		let reqId = this.#nextReqId()
		dbg.log('describing semaphore: %s (reqId: %s)', name, reqId)

		let request = create(SessionRequestSchema, {
			request: {
				case: 'describeSemaphore',
				value: create(SessionRequest_DescribeSemaphoreSchema, {
					reqId,
					name,
					includeOwners: options?.includeOwners ?? false,
					includeWaiters: options?.includeWaiters ?? false,
					watchData: options?.watchData ?? false,
					watchOwners: options?.watchOwners ?? false,
				}),
			},
		})

		let result = (await this.#stream.sendRequest(
			reqId,
			request,
			signal
		)) as SessionResponse_DescribeSemaphoreResult

		// Track this watch if enabled
		if (result.watchAdded && (options?.watchData || options?.watchOwners)) {
			this.#watchedSemaphores.set(reqId, name)
			dbg.log('watching semaphore: %s (reqId: %s)', name, reqId)
		}

		return {
			description: result.semaphoreDescription,
			watchAdded: result.watchAdded,
		}
	}

	/**
	 * Watches a semaphore for changes and yields descriptions on each change
	 *
	 * This method returns an AsyncIterable that automatically handles re-subscription
	 * when the semaphore changes.
	 *
	 * The iterator yields the initial description immediately, then yields new descriptions
	 * whenever the watched properties (data or owners) change.
	 *
	 * @param name - Name of the semaphore to watch
	 * @param options - Options for watching (data, owners, includeOwners, includeWaiters)
	 * @param signal - AbortSignal to stop watching
	 * @returns AsyncIterable that yields semaphore descriptions
	 *
	 * @example
	 * ```typescript
	 * // Watch for data changes
	 * for await (let desc of session.watch('config-sem', { data: true })) {
	 *   console.log('Config updated:', new TextDecoder().decode(desc.data))
	 *   if (shouldStop) {
	 *     break
	 *   }
	 * }
	 * ```
	 *
	 * @example
	 * ```typescript
	 * // Watch for owner changes
	 * for await (let desc of session.watch('lock-sem', { owners: true })) {
	 *   console.log('Lock owners:', desc.owners?.length)
	 * }
	 * ```
	 */
	async *watch(
		name: string,
		options?: WatchOptions,
		signal?: AbortSignal
	): AsyncIterable<SemaphoreDescription> {
		if (this.#closed) {
			throw new Error('Session is closed')
		}

		let watchData = options?.data ?? false
		let watchOwners = options?.owners ?? false

		if (!watchData && !watchOwners) {
			throw new Error(
				'At least one of options.data or options.owners must be true'
			)
		}

		// Auto-enable includeOwners if watching owners
		let includeOwners = options?.includeOwners ?? watchOwners
		let includeWaiters = options?.includeWaiters ?? false

		let getDescription = async (): Promise<SemaphoreDescription | null> => {
			let result = await this.describe(
				name,
				{
					includeOwners,
					includeWaiters,
					watchData,
					watchOwners,
				},
				signal
			)
			return result.description ?? null
		}

		let changeResolve: (() => void) | null = null
		let pendingChange = false

		let changeHandler = (event: SemaphoreChangedEvent) => {
			if (event.name !== name) {
				return
			}

			// Check if the change matches what we're watching
			let matches =
				(watchData && event.dataChanged) ||
				(watchOwners && event.ownersChanged)

			if (matches) {
				if (changeResolve) {
					changeResolve()
					changeResolve = null
				} else {
					pendingChange = true
				}
			}
		}

		let waitForChange = (): Promise<void> => {
			if (pendingChange) {
				pendingChange = false
				return Promise.resolve()
			}

			let promise = new Promise<void>((resolve) => {
				changeResolve = resolve
			})

			return (signal ? abortable(signal, promise) : promise).finally(
				() => {
					changeResolve = null
				}
			)
		}

		this.on(CoordinationSessionEvents.SEMAPHORE_CHANGED, changeHandler)

		try {
			while (!signal?.aborted) {
				// Re-subscribe and get updated description
				// eslint-disable-next-line no-await-in-loop
				let updated = await getDescription()
				if (updated) {
					yield updated
				}

				// eslint-disable-next-line no-await-in-loop
				await waitForChange()
			}
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				dbg.log('watch: stopped watching semaphore: %s', name)
				return
			}
			throw error
		} finally {
			this.off(CoordinationSessionEvents.SEMAPHORE_CHANGED, changeHandler)
			dbg.log('watch: cleanup completed for semaphore: %s', name)
		}
	}

	/**
	 * Closes the session
	 *
	 * @param signal - AbortSignal to timeout waiting for SessionStopped response.
	 *   If not provided, defaults to 5 second timeout.
	 *   Note: Session will be closed even if timeout occurs, but graceful shutdown may be incomplete.
	 */
	async close(
		signal: AbortSignal = AbortSignal.timeout(5000)
	): Promise<void> {
		if (this.#closed) {
			return
		}

		dbg.log('closing session: %s', this.#sessionId)

		this.#closed = true

		this.#watchedSemaphores.clear()

		// Create promise for waiting SessionStopped response
		let sessionStoppedPromise = new Promise<void>((resolve) => {
			this.#sessionStoppedResolve = resolve
		})

		let stopRequest = create(SessionRequestSchema, {
			request: {
				case: 'sessionStop',
				value: create(SessionRequest_SessionStopSchema, {}),
			},
		})

		// Send SessionStop request before waiting for response
		try {
			this.#stream.send(stopRequest)
		} catch (error) {
			dbg.log('error sending SessionStop request: %O', error)
		}

		try {
			await abortable(signal, sessionStoppedPromise)
		} catch (error) {
			dbg.log('error waiting for SessionStopped: %O', error)
		} finally {
			this.#sessionStoppedResolve = null
		}

		await this.#stream.close()

		dbg.log('session closed: %s', this.#sessionId)
	}

	/**
	 * Automatically closes the session when disposed
	 *
	 * This method is called automatically when using the `using` keyword.
	 * It provides the same functionality as close() but with a default timeout.
	 */
	async [Symbol.asyncDispose](): Promise<void> {
		dbg.log(
			'auto-closing session via Symbol.asyncDispose: %s',
			this.#sessionId
		)
		await this.close()
	}

	/**
	 * Gets the session ID
	 */
	get sessionId(): bigint {
		return this.#sessionId
	}

	/**
	 * Checks if the session is closed
	 */
	get isClosed(): boolean {
		return this.#closed
	}

	/**
	 * Test-only methods accessible via TEST_ONLY symbol
	 * @internal
	 */
	[TEST_ONLY]() {
		return {
			forceReconnect: () => {
				this.#stream.disconnect()
			},
		}
	}
}
