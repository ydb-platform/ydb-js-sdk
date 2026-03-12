import type { Driver } from '@ydbjs/core'

import { Election } from './election.js'
import { sessionRuntimeSymbol } from './internal/symbols.js'
import { Mutex } from './mutex.js'
import type { CoordinationSessionOptions } from './runtime/session-options.js'
import {
	type SessionRuntime,
	type SessionStatus,
	createRuntime as createSessionRuntime,
} from './runtime/session-runtime.js'
import { Semaphore } from './semaphore.js'

export type CoordinationSessionStatus = SessionStatus

export interface CreateSessionOptions extends CoordinationSessionOptions {
	path: string
}

export class CoordinationSession implements AsyncDisposable {
	#runtime: SessionRuntime;

	[sessionRuntimeSymbol]!: SessionRuntime

	constructor(driver: Driver, options: CreateSessionOptions, signal?: AbortSignal) {
		this.#runtime = createSessionRuntime(driver, options, signal)
		this[sessionRuntimeSymbol] = this.#runtime
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

	mutex(name: string): Mutex {
		return new Mutex(this, name)
	}

	semaphore(name: string): Semaphore {
		return new Semaphore(this, name)
	}

	election(name: string): Election {
		return new Election(this, name)
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
