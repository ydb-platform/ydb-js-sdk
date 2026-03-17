import { loggers } from '@ydbjs/debug'
import { getSessionRuntime } from './internal/session-runtime.js'
import { Lease, Semaphore } from './semaphore.js'
import type { CoordinationSession } from './session.js'

let dbg = loggers.coordination.extend('election')

export interface LeaderInfo {
	data: Uint8Array
}

export interface LeaderState {
	data: Uint8Array
	isMe: boolean
	// Aborts when the leader changes or the observation ends.
	// Always alive when the state is first yielded — never pre-aborted.
	signal: AbortSignal
}

export class Leadership implements AsyncDisposable {
	#name: string
	#lease: Lease
	#session: CoordinationSession
	#resigned = false

	constructor(lease: Lease, name: string, session: CoordinationSession) {
		this.#name = name
		this.#lease = lease
		this.#session = session
	}

	get signal(): AbortSignal {
		return this.#lease.signal
	}

	async proclaim(data: Uint8Array, signal?: AbortSignal): Promise<void> {
		throwIfAborted(signal)

		dbg.log('proclaiming leadership on %s (%d bytes)', this.#name, data.byteLength)
		return getSessionRuntime(this.#session).updateSemaphore(this.#name, data, signal)
	}

	async resign(signal?: AbortSignal): Promise<void> {
		if (this.#resigned) {
			return
		}

		dbg.log('resigning from leadership on %s', this.#name)
		this.#resigned = true
		await this.#lease.release(signal)
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.resign()
	}
}

export class Election {
	#name: string
	#session: CoordinationSession

	constructor(session: CoordinationSession, name: string) {
		this.#name = name
		this.#session = session
	}

	get name(): string {
		return this.#name
	}

	async campaign(data: Uint8Array, signal?: AbortSignal): Promise<Leadership> {
		dbg.log('campaigning for leadership on %s', this.#name)
		let semaphore = new Semaphore(this.#session, this.#name)
		let lease = await semaphore.acquire({ count: 1, data }, signal)

		dbg.log('became leader on %s', this.#name)
		return new Leadership(lease, this.#name, this.#session)
	}

	async *observe(signal?: AbortSignal): AsyncIterable<LeaderState> {
		dbg.log('observing leadership changes on %s', this.#name)
		let previousLeader: { sessionId: bigint; orderId: bigint } | null = null
		// Tracks the AbortController for the currently live LeaderState so we can
		// abort it as soon as the leader changes, before yielding the next state.
		let currentController: AbortController | null = null

		let semaphore = new Semaphore(this.#session, this.#name)
		try {
			for await (let description of semaphore.watch({ owners: true }, signal)) {
				let owner = description.owners?.[0]
				let currentLeader = owner
					? { sessionId: owner.sessionId, orderId: owner.orderId }
					: null

				if (isSameLeader(previousLeader, currentLeader)) {
					continue
				}

				previousLeader = currentLeader

				// Abort the previous state's signal before yielding the next one so
				// consumers see the transition in the right order.
				if (currentController) {
					currentController.abort(new Error('Leader changed'))
				}
				currentController = new AbortController()

				if (!owner) {
					dbg.log('no leader on %s', this.#name)
					yield {
						data: emptyBytes,
						isMe: false,
						signal: currentController.signal,
					}
					continue
				}

				let isMe =
					this.#session.sessionId !== null && owner.sessionId === this.#session.sessionId
				dbg.log(
					'leader changed on %s (sessionId=%s, isMe=%s)',
					this.#name,
					owner.sessionId,
					isMe
				)
				yield {
					data: owner.data,
					isMe,
					signal: currentController.signal,
				}
			}
		} finally {
			// Ensure the last yielded state's signal is aborted when iteration ends
			// so consumers relying on it for cancellation are always unblocked.
			dbg.log('stopped observing %s', this.#name)
			currentController?.abort(new Error('Election observation ended'))
		}
	}

	async leader(signal?: AbortSignal): Promise<LeaderInfo | null> {
		dbg.log('reading current leader on %s', this.#name)
		let semaphore = new Semaphore(this.#session, this.#name)
		let description = await semaphore.describe({ owners: true }, signal)
		let owner = description.owners?.[0]

		if (!owner) {
			dbg.log('no current leader on %s', this.#name)
			return null
		}

		dbg.log('current leader on %s is session %s', this.#name, owner.sessionId)
		return {
			data: owner.data,
		}
	}
}

let emptyBytes = new Uint8Array()

let isSameLeader = function isSameLeader(
	left: { sessionId: bigint; orderId: bigint } | null,
	right: { sessionId: bigint; orderId: bigint } | null
): boolean {
	if (!left || !right) {
		return left === right
	}

	return left.sessionId === right.sessionId && left.orderId === right.orderId
}

let throwIfAborted = function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw signal.reason ?? new Error('The operation was aborted')
	}
}
