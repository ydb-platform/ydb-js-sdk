import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { QueryServiceDefinition } from '@ydbjs/api/query'
import { abortable } from '@ydbjs/abortable'
import type { Driver } from '@ydbjs/core'
import { loggers } from '@ydbjs/debug'
import { YDBError } from '@ydbjs/error'

let dbg = loggers.query.extend('session')

export type SessionState = 'idle' | 'busy' | 'closed' | 'invalidated'

export let SESSION_STATE = {
	IDLE: 'idle' as const,
	BUSY: 'busy' as const,
	CLOSED: 'closed' as const,
	INVALIDATED: 'invalidated' as const,
}

export class Session {
	#driver: Driver
	#sessionId: string
	#nodeId: bigint
	#state: SessionState = SESSION_STATE.IDLE
	#createdAt: number = Date.now()
	#lastUsedAt: number = Date.now()
	#attachController?: AbortController | undefined
	#onInvalidated?: () => void

	constructor(driver: Driver, sessionId: string, nodeId: bigint) {
		this.#driver = driver
		this.#sessionId = sessionId
		this.#nodeId = nodeId

		dbg.log('created session %s on node %d', sessionId, nodeId)
	}

	/**
	 * Set callback to be called when session is invalidated by server
	 */
	onInvalidated(callback: () => void): void {
		this.#onInvalidated = callback
	}

	get id(): string {
		return this.#sessionId
	}

	get nodeId(): bigint {
		return this.#nodeId
	}

	get state(): SessionState {
		return this.#state
	}

	get createdAt(): number {
		return this.#createdAt
	}

	get lastUsedAt(): number {
		return this.#lastUsedAt
	}

	get isIdle(): boolean {
		return this.#state === SESSION_STATE.IDLE
	}

	get isBusy(): boolean {
		return this.#state === SESSION_STATE.BUSY
	}

	get isClosed(): boolean {
		return this.#state === SESSION_STATE.CLOSED
	}

	get isInvalidated(): boolean {
		return this.#state === SESSION_STATE.INVALIDATED
	}

	/**
	 * Mark session as invalidated by server or attach failure
	 */
	markInvalidated(): void {
		if (
			this.#state === SESSION_STATE.CLOSED ||
			this.#state === SESSION_STATE.INVALIDATED
		) {
			return
		}

		this.#state = SESSION_STATE.INVALIDATED
		dbg.log('marked session %s as invalidated', this.#sessionId)

		// Clean up attach stream if it exists
		if (this.#attachController) {
			this.#attachController.abort()
			this.#attachController = undefined
		}

		if (this.#onInvalidated) {
			this.#onInvalidated()
		}
	}

	/**
	 * Mark session as busy (in use)
	 */
	async acquire(signal?: AbortSignal): Promise<void> {
		if (this.#state !== SESSION_STATE.IDLE) {
			throw new Error(`Cannot acquire session in state ${this.#state}`)
		}

		this.#state = SESSION_STATE.BUSY
		this.#lastUsedAt = Date.now()
		dbg.log('acquired session %s', this.#sessionId)

		if (!this.#attachController) {
			try {
				await this.#attach(signal)
			} catch (error) {
				// Mark as invalidated on attach failure
				this.markInvalidated()
				throw error
			}
		}
	}

	/**
	 * Attach session to keep it alive
	 */
	async #attach(signal?: AbortSignal): Promise<void> {
		dbg.log('attaching session %s', this.#sessionId)

		this.#attachController = new AbortController()

		let attachClient = this.#driver.createClient(
			QueryServiceDefinition,
			this.#nodeId
		)
		let attachStream = attachClient.attachSession(
			{ sessionId: this.#sessionId },
			{ signal: this.#attachController.signal }
		)

		let attachIterator = attachStream[Symbol.asyncIterator]()

		let attachSessionResult = signal
			? await abortable(signal, attachIterator.next())
			: await attachIterator.next()

		if (attachSessionResult.value.status !== StatusIds_StatusCode.SUCCESS) {
			dbg.log(
				'failed to attach session, status: %d',
				attachSessionResult.value.status
			)

			throw new YDBError(
				attachSessionResult.value.status,
				attachSessionResult.value.issues
			)
		}

		dbg.log('attached to session %s', this.#sessionId)

		this.#monitorAttachStream(attachStream)
	}

	/**
	 * Monitor attach stream for session invalidation
	 * Runs in background and marks session as invalidated when stream ends or errors
	 */
	async #monitorAttachStream(
		attachStream: AsyncIterable<any>
	): Promise<void> {
		dbg.log(
			'starting attach stream monitor for session %s',
			this.#sessionId
		)

		try {
			for await (let message of attachStream) {
				if (message.status !== StatusIds_StatusCode.SUCCESS) {
					dbg.log(
						'attach stream error for session %s, status: %d',
						this.#sessionId,
						message.status
					)
					break
				}
			}

			dbg.log('attach stream closed for session %s', this.#sessionId)
		} catch (error) {
			dbg.log(
				'attach stream error for session %s: %O',
				this.#sessionId,
				error
			)
		} finally {
			this.markInvalidated()
		}
	}

	/**
	 * Mark session as idle (available for reuse)
	 */
	release(): void {
		if (this.#state !== SESSION_STATE.BUSY) {
			throw new Error(`Cannot release session in state ${this.#state}`)
		}

		this.#state = SESSION_STATE.IDLE
		this.#lastUsedAt = Date.now()
		dbg.log('released session %s', this.#sessionId)
	}

	/**
	 * Delete session on the server
	 */
	async delete(signal?: AbortSignal): Promise<void> {
		if (this.#state === SESSION_STATE.CLOSED) {
			dbg.log('session %s already closed', this.#sessionId)
			return
		}

		dbg.log('deleting session %s', this.#sessionId)

		try {
			let client = this.#driver.createClient(
				QueryServiceDefinition,
				this.#nodeId
			)

			await client.deleteSession(
				{ sessionId: this.#sessionId },
				signal ? { signal } : {}
			)

			this.#state = SESSION_STATE.CLOSED
			dbg.log('deleted session %s', this.#sessionId)

			if (this.#attachController) {
				dbg.log(
					'aborting attach stream for session %s',
					this.#sessionId
				)
				this.#attachController.abort()
				this.#attachController = undefined
			}
		} catch (error) {
			dbg.log('failed to delete session %s: %O', this.#sessionId, error)
			this.#state = SESSION_STATE.CLOSED
			throw error
		}
	}

	/**
	 * Create a new session
	 */
	static async create(
		driver: Driver,
		signal?: AbortSignal
	): Promise<Session> {
		dbg.log('creating new session')

		let client = driver.createClient(QueryServiceDefinition)

		let response = await client.createSession({}, signal ? { signal } : {})

		if (response.status !== StatusIds_StatusCode.SUCCESS) {
			dbg.log('failed to create session, status: %d', response.status)
			throw new YDBError(response.status, response.issues)
		}

		let sessionId = response.sessionId
		let nodeId = response.nodeId

		dbg.log('created session %s on node %d', sessionId, nodeId)

		return new Session(driver, sessionId, nodeId)
	}
}
