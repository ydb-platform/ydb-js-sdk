import type { CoordinationSession } from './session.js'
import { loggers } from '@ydbjs/debug'
import { getSessionRuntime } from './internal/session-runtime.js'
import { isTryAcquireMiss } from './internal/try-acquire.js'
import { Lease } from './semaphore.js'
import type { SessionRuntime } from './runtime/session-runtime.js'

let dbg = loggers.coordination.extend('mutex')

// Ephemeral semaphores in YDB have a server-hardcoded limit of MAX_UINT64.
// Mutex exclusivity is achieved by acquiring all tokens at once — no other
// session can acquire even a single token while they are all held.
// When the lease is released the ephemeral semaphore is deleted automatically.
let mutexCapacity = 2n ** 64n - 1n

// Passing MAX_UINT64 as timeoutMillis tells the server to keep the request in
// the waiters queue indefinitely.  timeoutMillis: 0 means "return immediately
// if not available", which is the tryLock semantics — not what lock() wants.
let waitIndefinitely = mutexCapacity

// Lock is the public name for a held mutex token.
// Extends Lease so the implementation lives in one place — the only difference
// is the type name, which keeps the public API expressive.
export class Lock extends Lease {}

export class Mutex {
	#name: string
	#runtime: SessionRuntime

	constructor(session: CoordinationSession, name: string) {
		this.#name = name
		this.#runtime = getSessionRuntime(session)
	}

	get name(): string {
		return this.#name
	}

	async lock(signal?: AbortSignal): Promise<Lock> {
		dbg.log('waiting to acquire lock on %s', this.#name)
		let lease = await this.#runtime.acquireSemaphore(
			this.#name,
			{ count: mutexCapacity, ephemeral: true, waitTimeout: waitIndefinitely },
			signal
		)

		dbg.log('lock acquired on %s', this.#name)
		return new Lock(this.#name, lease)
	}

	async tryLock(signal?: AbortSignal): Promise<Lock | null> {
		dbg.log('trying to acquire lock on %s without waiting', this.#name)
		try {
			let lease = await this.#runtime.acquireSemaphore(
				this.#name,
				{ count: mutexCapacity, ephemeral: true, waitTimeout: 0 },
				signal
			)

			dbg.log('lock acquired on %s', this.#name)
			return new Lock(this.#name, lease)
		} catch (error) {
			if (isTryAcquireMiss(error)) {
				dbg.log('%s is already locked, skipping', this.#name)
				return null
			}

			throw error
		}
	}
}
