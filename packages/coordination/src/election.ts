import { loggers } from '@ydbjs/debug'

import { LeaderChangedError, ObservationEndedError } from './errors.js'
import { Lease, Semaphore } from './semaphore.js'

let dbg = loggers.coordination.extend('election')

let emptyBytes = new Uint8Array()

export interface LeaderInfo {
	data: Uint8Array
}

export interface LeaderState {
	data: Uint8Array
	isMe: boolean
	signal: AbortSignal
}

export class Leadership implements AsyncDisposable {
	#semaphore: Semaphore
	#lease: Lease
	#resigned = false

	constructor(lease: Lease, semaphore: Semaphore) {
		this.#lease = lease
		this.#semaphore = semaphore
	}

	get signal(): AbortSignal {
		return this.#lease.signal
	}

	async proclaim(data: Uint8Array, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted()
		dbg.log('proclaiming leadership on %s (%d bytes)', this.#semaphore.name, data.byteLength)
		return this.#semaphore.update(data, signal)
	}

	async resign(signal?: AbortSignal): Promise<void> {
		if (this.#resigned) {
			return
		}

		this.#resigned = true
		dbg.log('resigning from leadership on %s', this.#semaphore.name)
		await this.#lease.release(signal)
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.resign()
	}
}

export class Election {
	#semaphore: Semaphore
	#sessionId: () => bigint | null

	constructor(semaphore: Semaphore, sessionId: () => bigint | null) {
		this.#semaphore = semaphore
		this.#sessionId = sessionId
	}

	get name(): string {
		return this.#semaphore.name
	}

	async campaign(data: Uint8Array, signal?: AbortSignal): Promise<Leadership> {
		dbg.log('campaigning for leadership on %s', this.name)

		let lease = await this.#semaphore.acquire({ count: 1, data }, signal)

		dbg.log('won leadership on %s', this.name)
		return new Leadership(lease, this.#semaphore)
	}

	async *observe(signal?: AbortSignal): AsyncIterable<LeaderState> {
		dbg.log('observing leadership changes on %s', this.name)

		let previousLeader: { sessionId: bigint; orderId: bigint } | null = null
		let currentController: AbortController | null = null

		try {
			for await (let description of this.#semaphore.watch({ owners: true }, signal)) {
				let owner = description.owners?.[0]
				let currentLeader = owner
					? { sessionId: owner.sessionId, orderId: owner.orderId }
					: null

				if (isSameLeader(previousLeader, currentLeader)) {
					continue
				}

				previousLeader = currentLeader

				if (currentController) {
					currentController.abort(new LeaderChangedError())
				}
				currentController = new AbortController()

				if (!owner) {
					dbg.log('no leader on %s', this.name)
					yield { data: emptyBytes, isMe: false, signal: currentController.signal }
					continue
				}

				let sessionId = this.#sessionId()
				let isMe = sessionId !== null && owner.sessionId === sessionId
				dbg.log(
					'leader changed on %s (sessionId=%s, isMe=%s)',
					this.name,
					owner.sessionId,
					isMe
				)
				yield { data: owner.data, isMe, signal: currentController.signal }
			}
		} finally {
			dbg.log('stopped observing %s', this.name)
			currentController?.abort(new ObservationEndedError())
		}
	}

	async leader(signal?: AbortSignal): Promise<LeaderInfo | null> {
		let description = await this.#semaphore.describe({ owners: true }, signal)
		let owner = description.owners?.[0]
		return owner ? { data: owner.data } : null
	}
}

let isSameLeader = function isSameLeader(
	left: { sessionId: bigint; orderId: bigint } | null,
	right: { sessionId: bigint; orderId: bigint } | null
): boolean {
	if (!left || !right) {
		return left === right
	}

	return left.sessionId === right.sessionId && left.orderId === right.orderId
}
