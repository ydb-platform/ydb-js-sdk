import type { Driver } from '@ydbjs/core'
import { loggers } from '@ydbjs/debug'
import { Session } from './session.js'

let dbg = loggers.query.extend('pool')

export type SessionPoolOptions = {
	/**
	 * Maximum number of sessions in the pool
	 * @default 50
	 */
	maxSize?: number

	/**
	 * Time in milliseconds after which an idle session is considered stale and removed
	 * @default 600000 (10 minutes)
	 */
	idleTimeoutMs?: number

	/**
	 * Interval in milliseconds for checking and removing stale sessions
	 * @default 60000 (1 minute)
	 */
	cleanupIntervalMs?: number
}

const defaultOptions: Required<SessionPoolOptions> = {
	maxSize: 50,
	idleTimeoutMs: 600_000, // 10 minutes
	cleanupIntervalMs: 60_000, // 1 minute
}

export class SessionPool implements Disposable {
	#driver: Driver
	#options: Required<SessionPoolOptions>

	#sessions: Session[] = []
	#waitQueue: Array<{
		resolve: (session: Session) => void
		reject: (error: Error) => void
	}> = []

	#cleanupTimer?: NodeJS.Timeout
	#closed: boolean = false
	#creating: number = 0 // Track sessions being created

	constructor(driver: Driver, options: SessionPoolOptions = {}) {
		this.#driver = driver
		this.#options = { ...defaultOptions, ...options }

		dbg.log('creating session pool (max: %d)', this.#options.maxSize)

		// Start cleanup timer
		this.#cleanupTimer = setInterval(() => {
			void this.#cleanup()
		}, this.#options.cleanupIntervalMs)

		// Unref so it doesn't keep process alive
		this.#cleanupTimer.unref()
	}

	/**
	 * Get pool statistics
	 */
	get stats() {
		let idle = 0
		let busy = 0
		let closed = 0

		for (let session of this.#sessions) {
			if (session.isIdle) idle++
			else if (session.isBusy) busy++
			else if (session.isClosed) closed++
		}

		return {
			total: this.#sessions.length,
			idle,
			busy,
			closed,
			waiting: this.#waitQueue.length,
			maxSize: this.#options.maxSize,
		}
	}

	/**
	 * Acquire a session from the pool
	 */
	async acquire(signal?: AbortSignal): Promise<Session> {
		if (this.#closed) {
			throw new Error('Session pool is closed')
		}

		if (signal?.aborted) {
			throw signal.reason || new Error('Aborted')
		}

		let session = this.#findIdleSession()
		if (session) {
			session.acquire()
			dbg.log(
				'acquired existing session %s (pool stats: %o)',
				session.id,
				this.stats
			)
			return session
		}

		let totalSessions = this.#sessions.length + this.#creating
		if (totalSessions < this.#options.maxSize) {
			dbg.log(
				'creating new session (current: %d, creating: %d, max: %d)',
				this.#sessions.length,
				this.#creating,
				this.#options.maxSize
			)

			this.#creating++

			let failed = false
			let createError: unknown

			try {
				session = await Session.create(this.#driver, signal)

				this.#sessions.push(session)
				session.acquire()

				dbg.log(
					'acquired new session %s (pool stats: %o)',
					session.id,
					this.stats
				)

				return session
			} catch (error) {
				failed = true
				createError = error
				throw error
			} finally {
				this.#creating--

				if (failed) {
					dbg.log(
						'rejecting %d waiters to trigger retry',
						this.#waitQueue.length
					)

					this.#rejectAllWaiters(createError)
				}
			}
		}

		dbg.log(
			'pool is full (%d+%d/%d), waiting for session',
			this.#sessions.length,
			this.#creating,
			this.#options.maxSize
		)

		return this.#waitForSession(signal)
	}

	/**
	 * Release a session back to the pool
	 */
	release(session: Session): void {
		if (this.#closed) {
			dbg.log(
				'pool is closed, ignoring release of session %s',
				session.id
			)
			return
		}

		let waiter = this.#waitQueue.shift()
		if (waiter) {
			dbg.log('giving session %s to waiter', session.id)
			waiter.resolve(session)
			return
		}

		// No waiters, mark session as idle
		session.release()

		dbg.log('released session %s (pool stats: %o)', session.id, this.stats)
	}

	/**
	 * Find an idle session in the pool
	 */
	#findIdleSession(): Session | null {
		for (let session of this.#sessions) {
			if (session.isIdle) {
				return session
			}
		}
		return null
	}

	/**
	 * Wait for a session to become available
	 */
	#waitForSession(signal?: AbortSignal): Promise<Session> {
		return new Promise<Session>((resolve, reject) => {
			let waiter = { resolve, reject }

			if (signal) {
				let cleanup = () => {
					let index = this.#waitQueue.indexOf(waiter)
					if (index !== -1) {
						this.#waitQueue.splice(index, 1)
					}
				}

				let abortHandler = () => {
					cleanup()
					reject(signal.reason || new Error('Aborted'))
				}
				signal.addEventListener('abort', abortHandler, { once: true })

				let removeListener = () =>
					signal.removeEventListener('abort', abortHandler)

				waiter.resolve = (value) => {
					removeListener()
					resolve(value)
				}

				waiter.reject = (error) => {
					removeListener()
					reject(error)
				}
			}

			this.#waitQueue.push(waiter)
		})
	}

	/**
	 * Reject all waiting requests with an error
	 */
	#rejectAllWaiters(error: unknown): void {
		let waitersToNotify = this.#waitQueue.splice(0)
		if (waitersToNotify.length === 0) {
			return
		}

		let err =
			error instanceof Error
				? error
				: new Error('Session creation failed', { cause: error })

		for (let waiter of waitersToNotify) {
			waiter.reject(err)
		}
	}

	/**
	 * Remove a session from the pool
	 */
	#removeSession(session: Session): void {
		let index = this.#sessions.indexOf(session)
		if (index !== -1) {
			this.#sessions.splice(index, 1)
			dbg.log('removed session %s from pool', session.id)
		}
	}

	/**
	 * Clean up stale sessions
	 */
	async #cleanup(): Promise<void> {
		if (this.#closed) {
			return
		}

		let now = Date.now()
		let stale = this.#sessions.filter(
			(session) =>
				session.isIdle &&
				now - session.lastUsedAt > this.#options.idleTimeoutMs
		)

		if (stale.length === 0) {
			return
		}

		dbg.log('cleaning up %d stale sessions', stale.length)

		for (let session of stale) {
			this.#removeSession(session)
		}

		await Promise.all(
			stale.map((session) =>
				session.delete().catch((error) => {
					dbg.log(
						'failed to delete stale session %s: %O',
						session.id,
						error
					)
				})
			)
		)

		dbg.log('cleanup complete (pool stats: %o)', this.stats)
	}

	/**
	 * Close the pool and delete all sessions
	 */
	async close(signal?: AbortSignal): Promise<void> {
		if (this.#closed) {
			return
		}

		dbg.log('closing session pool')
		this.#closed = true

		if (this.#cleanupTimer) {
			clearInterval(this.#cleanupTimer)
		}

		this.#rejectAllWaiters(new Error('Session pool is closed'))

		let promises = this.#sessions.map((session) =>
			session.delete(signal).catch((error) => {
				dbg.log('failed to delete session %s: %O', session.id, error)
			})
		)

		await Promise.all(promises)
		this.#sessions = []

		dbg.log('session pool closed')
	}

	[Symbol.dispose](): void {
		void this.close()
	}
}
