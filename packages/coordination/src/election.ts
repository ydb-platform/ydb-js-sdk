import { getSessionRuntime } from './internal/session-runtime.js'
import { Lease, Semaphore } from './semaphore.js'
import type { CoordinationSession } from './session.js'

export interface LeaderInfo {
	data: Uint8Array
}

export interface LeaderState {
	data: Uint8Array
	isMe: boolean
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

		return getSessionRuntime(this.#session).updateSemaphore(this.#name, { data }, signal)
	}

	async resign(signal?: AbortSignal): Promise<void> {
		if (this.#resigned) {
			return
		}

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
		let semaphore = new Semaphore(this.#session, this.#name)
		let lease = await semaphore.acquire({ count: 1, data }, signal)

		return new Leadership(lease, this.#name, this.#session)
	}

	async *observe(signal?: AbortSignal): AsyncIterable<LeaderState> {
		let previousLeader: { sessionId: bigint; orderId: bigint } | null = null

		let semaphore = new Semaphore(this.#session, this.#name)
		for await (let description of semaphore.watch({ owners: true }, signal)) {
			let owner = description.owners?.[0]
			let currentLeader = owner
				? { sessionId: owner.sessionId, orderId: owner.orderId }
				: null

			if (isSameLeader(previousLeader, currentLeader)) {
				continue
			}

			previousLeader = currentLeader

			if (!owner) {
				yield {
					data: emptyBytes,
					isMe: false,
					signal: AbortSignal.abort(new Error('Leader is not available')),
				}
				continue
			}

			yield {
				data: owner.data,
				isMe:
					this.#session.sessionId !== null && owner.sessionId === this.#session.sessionId,
				signal:
					owner.sessionId === this.#session.sessionId
						? this.#session.signal
						: AbortSignal.abort(new Error('Leader changed')),
			}
		}
	}

	async leader(signal?: AbortSignal): Promise<LeaderInfo | null> {
		let semaphore = new Semaphore(this.#session, this.#name)
		let description = await semaphore.describe({ owners: true }, signal)
		let owner = description.owners?.[0]

		if (!owner) {
			return null
		}

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

export let createElection = function createElection(
	session: CoordinationSession,
	name: string
): Election {
	return new Election(session, name)
}
