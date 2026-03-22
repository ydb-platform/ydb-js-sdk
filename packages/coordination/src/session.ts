import type { Driver } from '@ydbjs/core'

import { Election } from './election.js'
import { Mutex } from './mutex.js'
import {
	type CreateSessionOptions,
	type SessionRuntime,
	type SessionStatus,
	createRuntime,
} from './runtime/session-runtime.js'
import { Semaphore } from './semaphore.js'

export type CoordinationSessionStatus = SessionStatus

export type { CreateSessionOptions }

export class CoordinationSession implements AsyncDisposable {
	#runtime: SessionRuntime

	constructor(driver: Driver, options: CreateSessionOptions, signal?: AbortSignal) {
		this.#runtime = createRuntime(driver, options, signal)
	}

	get sessionId(): bigint | null {
		return this.#runtime.sessionId
	}

	get status(): CoordinationSessionStatus {
		return this.#runtime.status
	}

	get signal(): AbortSignal {
		return this.#runtime.signal
	}

	semaphore(name: string): Semaphore {
		return new Semaphore(name, this.#runtime.transport, this.signal)
	}

	mutex(name: string): Mutex {
		return new Mutex(this.semaphore(name))
	}

	election(name: string): Election {
		return new Election(this.semaphore(name), () => this.#runtime.sessionId)
	}

	waitReady(signal?: AbortSignal): Promise<void> {
		return this.#runtime.transport.waitReady(signal)
	}

	close(signal?: AbortSignal): Promise<void> {
		return this.#runtime.close(signal)
	}

	destroy(reason?: unknown): void {
		this.#runtime.destroy(reason)
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.#runtime.close()
	}
}
