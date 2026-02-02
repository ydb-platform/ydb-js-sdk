import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { QueryServiceDefinition } from '@ydbjs/api/query'
import type { SessionState as SessionStateProto } from '@ydbjs/api/query'
import type { Driver } from '@ydbjs/core'
import { loggers } from '@ydbjs/debug'
import { YDBError } from '@ydbjs/error'

let dbg = loggers.query.extend('session')

export enum SessionState {
	IDLE = 'idle',
	BUSY = 'busy',
	CLOSED = 'closed',
}

export class Session {
	#driver: Driver
	#sessionId: string
	#nodeId: bigint
	#state: SessionState = SessionState.IDLE
	#createdAt: number = Date.now()
	#lastUsedAt: number = Date.now()
	#attachIterator?: AsyncIterator<SessionStateProto> | undefined

	constructor(
		driver: Driver,
		sessionId: string,
		nodeId: bigint,
		attachIterator?: AsyncIterator<SessionStateProto>
	) {
		this.#driver = driver
		this.#sessionId = sessionId
		this.#nodeId = nodeId
		this.#attachIterator = attachIterator

		dbg.log('created session %s on node %d', sessionId, nodeId)
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
		return this.#state === SessionState.IDLE
	}

	get isBusy(): boolean {
		return this.#state === SessionState.BUSY
	}

	get isClosed(): boolean {
		return this.#state === SessionState.CLOSED
	}

	/**
	 * Mark session as busy (in use)
	 */
	acquire(): void {
		if (this.#state !== SessionState.IDLE) {
			throw new Error(`Cannot acquire session in state ${this.#state}`)
		}

		this.#state = SessionState.BUSY
		this.#lastUsedAt = Date.now()
		dbg.log('acquired session %s', this.#sessionId)
	}

	/**
	 * Mark session as idle (available for reuse)
	 */
	release(): void {
		if (this.#state !== SessionState.BUSY) {
			throw new Error(`Cannot release session in state ${this.#state}`)
		}

		this.#state = SessionState.IDLE
		this.#lastUsedAt = Date.now()
		dbg.log('released session %s', this.#sessionId)
	}

	/**
	 * Delete session on the server
	 */
	async delete(signal?: AbortSignal): Promise<void> {
		if (this.#state === SessionState.CLOSED) {
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

			if (this.#attachIterator) {
				dbg.log('closing attach stream for session %s', this.#sessionId)
				try {
					await this.#attachIterator.return?.()
				} catch (error) {
					dbg.log('error closing attach stream: %O', error)
				}
				this.#attachIterator = undefined
			}

			this.#state = SessionState.CLOSED
			dbg.log('deleted session %s', this.#sessionId)
		} catch (error) {
			dbg.log('failed to delete session %s: %O', this.#sessionId, error)
			this.#state = SessionState.CLOSED
			throw error
		}
	}

	/**
	 * Create a new session with keepalive stream
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

		// Attach to session to keep it alive
		let attachClient = driver.createClient(QueryServiceDefinition, nodeId)
		let attachStream = attachClient.attachSession({ sessionId })
		let attachIterator = attachStream[Symbol.asyncIterator]()

		let attachSessionResult = await attachIterator.next()
		if (attachSessionResult.value.status !== StatusIds_StatusCode.SUCCESS) {
			dbg.log(
				'failed to attach session, status: %d',
				attachSessionResult.value.status
			)

			void attachIterator.return?.().catch((error) => {
				dbg.log(
					'error closing attach stream after attach failure: %O',
					error
				)
			})

			throw new YDBError(
				attachSessionResult.value.status,
				attachSessionResult.value.issues
			)
		}

		dbg.log('attached to session %s', sessionId)

		return new Session(driver, sessionId, nodeId, attachIterator)
	}
}
