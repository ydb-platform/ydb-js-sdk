import { loggers } from '@ydbjs/debug'

import type { CoordinationSession } from './session.js'

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
	 * AbortSignal that aborts when lock is lost involuntarily
	 * (session died, server released it)
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
 * Semaphore handle that represents an acquired lock
 *
 * This class implements the Lock interface and provides automatic cleanup
 * when disposed. The lock is automatically released when the scope exits
 * (using `await using` keyword) or when explicitly released.
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
export class Semaphore implements Lock {
	#session: CoordinationSession
	#name: string
	#released: boolean = false
	#abortController: AbortController

	constructor(session: CoordinationSession, name: string) {
		this.#session = session
		this.#name = name
		this.#abortController = new AbortController()

		// Subscribe to session expiration to abort lock signal
		this.#session.on('sessionExpired', () => {
			if (!this.#abortController.signal.aborted) {
				dbg.log(
					'session expired, aborting lock signal for: %s',
					this.#name
				)
				this.#abortController.abort(
					new Error('Lock lost: session expired')
				)
			}
		})
	}

	/**
	 * AbortSignal that aborts when lock is lost involuntarily
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
