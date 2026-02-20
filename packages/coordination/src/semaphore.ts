import { loggers } from '@ydbjs/debug'

import {
	type CoordinationSession,
	CoordinationSessionEvents,
} from './session.js'

let dbg = loggers.driver.extend('coordination').extend('semaphore')

/**
 * Lock interface for acquired semaphores
 *
 * Represents an acquired lock with automatic cleanup and loss detection.
 * The signal property aborts when the lock is lost involuntarily
 * (session expired or server released it).
 *
 * @example
 * ```typescript
 * await using lock = await session.acquire('my-lock')
 * // Use lock.signal to detect involuntary lock loss
 * await someOperation({ signal: lock.signal })
 * // Lock automatically released on scope exit
 * ```
 */
export interface Lock extends AsyncDisposable {
	/**
	 * Name of the acquired semaphore
	 */
	name: string

	/**
	 * AbortSignal that aborts when the coordination session expires.
	 *
	 * When the session expires, the server automatically releases all locks held by that session.
	 * This signal allows you to detect session expiration and stop ongoing operations gracefully.
	 */
	signal: AbortSignal

	/**
	 * Explicitly releases the lock
	 */
	release(): Promise<void>

	/**
	 * Called automatically via await using, internally calls release()
	 */
	[Symbol.asyncDispose](): Promise<void>
}

/**
 * Semaphore lock handle that represents an acquired semaphore
 *
 * This class implements the Lock interface and provides automatic cleanup
 * when disposed. The lock is automatically released when the scope exits
 * (using `await using` keyword) or when explicitly released.
 *
 * The session that created this lock remains open after release.
 *
 * @example
 * ```typescript
 * // Automatic release with using keyword
 * await using lock = await session.acquire('my-lock')
 * // Critical section - lock is guaranteed to be held
 * // Use lock.signal to detect involuntary lock loss
 * await someOperation({ signal: lock.signal })
 * // Lock automatically released here
 * ```
 */
export class SemaphoreLock implements Lock {
	#session: CoordinationSession
	#name: string
	#released: boolean = false
	#abortController: AbortController
	#sessionExpiredHandler: () => void

	constructor(session: CoordinationSession, name: string) {
		this.#session = session
		this.#name = name
		this.#abortController = new AbortController()

		// Subscribe to session expiration to abort lock signal
		this.#sessionExpiredHandler = () => {
			if (!this.#abortController.signal.aborted) {
				dbg.log(
					'session expired, aborting lock signal for: %s',
					this.#name
				)
				this.#abortController.abort(
					new Error('Lock lost: session expired')
				)
			}
			// Mark as released since server automatically released the semaphore
			this.#released = true
		}
		this.#session.once(
			CoordinationSessionEvents.SESSION_EXPIRED,
			this.#sessionExpiredHandler
		)
	}

	/**
	 * AbortSignal that aborts when the coordination session expires.
	 *
	 * When the session expires, the server automatically releases all locks held by that session.
	 * This signal allows you to detect session expiration and stop ongoing operations gracefully.
	 */
	get signal(): AbortSignal {
		return this.#abortController.signal
	}

	/**
	 * Returns the semaphore name
	 */
	get name(): string {
		return this.#name
	}

	/**
	 * Explicitly releases the lock
	 *
	 * This method can be called explicitly to release the semaphore.
	 * Useful when not using the `await using` keyword.
	 *
	 * @param signal - AbortSignal to timeout the operation
	 * @throws {YDBError} If the operation fails
	 *
	 * @example
	 * ```typescript
	 * let lock = await session.acquire('my-lock')
	 * try {
	 *   // do work with lock
	 * } finally {
	 *   await lock.release()
	 * }
	 * ```
	 */
	async release(signal?: AbortSignal): Promise<void> {
		if (this.#released) {
			return
		}

		this.#session.off(
			CoordinationSessionEvents.SESSION_EXPIRED,
			this.#sessionExpiredHandler
		)
		await this.#session.release(this.#name, signal)
		this.#released = true
	}

	/**
	 * Automatically releases the lock when disposed
	 *
	 * This method is called automatically when using the `await using` keyword.
	 */
	async [Symbol.asyncDispose](): Promise<void> {
		if (!this.#released) {
			dbg.log(
				'auto-releasing semaphore via Symbol.asyncDispose: %s',
				this.#name
			)
			await this.release()
		}
	}
}

/**
 * Session-owned lock that manages session lifecycle automatically
 *
 * This class combines session creation, semaphore acquisition, and automatic cleanup
 * into a single high-level API. The session is created when the lock is acquired
 * and automatically closed when the lock is released.
 *
 * Implements AsyncDisposable for automatic cleanup with `await using` keyword.
 *
 * @example
 * ```typescript
 * // Automatic session + lock management
 * await using lock = await client.acquireLock('/local/node', 'my-lock')
 * // Session is created, lock is acquired
 * // Do work with lock
 * // Lock is released and session is closed automatically
 * ```
 */
export class SessionOwnedLock implements Lock {
	#session: CoordinationSession
	#lock: Lock
	#released: boolean = false

	constructor(session: CoordinationSession, lock: Lock) {
		this.#session = session
		this.#lock = lock
	}

	/**
	 * Name of the acquired lock
	 */
	get name(): string {
		return this.#lock.name
	}

	/**
	 * AbortSignal that aborts when lock is lost involuntarily
	 * (session died, server released it)
	 */
	get signal(): AbortSignal {
		return this.#lock.signal
	}

	/**
	 * Explicitly releases the lock and closes the session
	 *
	 * This method can be called explicitly to release the lock and close the session.
	 * Useful when not using the `await using` keyword.
	 *
	 * @throws {YDBError} If the operation fails
	 *
	 * @example
	 * ```typescript
	 * let lock = await client.acquireLock('/local/node', 'my-lock')
	 * try {
	 *   // do work with lock
	 * } finally {
	 *   await lock.release()
	 * }
	 * ```
	 */
	async release(): Promise<void> {
		if (this.#released) {
			return
		}

		dbg.log('releasing distributed lock: %s', this.#lock.name)

		try {
			await this.#lock.release()
		} finally {
			await this.#session.close()
			this.#released = true
		}

		dbg.log('distributed lock released: %s', this.#lock.name)
	}

	/**
	 * Automatically releases the lock and closes the session when disposed
	 */
	async [Symbol.asyncDispose](): Promise<void> {
		if (!this.#released) {
			dbg.log(
				'auto-releasing distributed lock via Symbol.asyncDispose: %s',
				this.#lock.name
			)
			await this.release()
		}
	}
}
