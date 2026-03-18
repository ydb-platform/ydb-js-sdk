import { loggers } from '@ydbjs/debug'

import { Lease, Semaphore } from './semaphore.js'

let dbg = loggers.coordination.extend('mutex')

let mutexCapacity = 2n ** 64n - 1n

export type Lock = Lease

export class Mutex {
	#semaphore: Semaphore

	constructor(semaphore: Semaphore) {
		this.#semaphore = semaphore
	}

	get name(): string {
		return this.#semaphore.name
	}

	async lock(signal?: AbortSignal): Promise<Lock> {
		dbg.log('waiting to acquire lock on %s', this.name)
		let lease = await this.#semaphore.acquire({ count: mutexCapacity, ephemeral: true }, signal)
		dbg.log('lock acquired on %s', this.name)
		return lease
	}

	async tryLock(signal?: AbortSignal): Promise<Lock | null> {
		dbg.log('trying to acquire lock on %s without waiting', this.name)
		let lease = await this.#semaphore.tryAcquire(
			{ count: mutexCapacity, ephemeral: true },
			signal
		)
		if (!lease) {
			dbg.log('%s is already locked, skipping', this.name)
			return null
		}
		dbg.log('lock acquired on %s', this.name)
		return lease
	}
}
