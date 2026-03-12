import type { Driver } from '@ydbjs/core'

import { CoordinationNodeRuntime } from './runtime/node-runtime.js'
import { getSessionRuntime } from './internal/session-runtime.js'
import type { CoordinationNodeConfig, CoordinationNodeDescription } from './runtime/node-runtime.js'
import { CoordinationSession } from './session.js'

export interface SessionOptions {
	description?: string
	recoveryWindow?: number
	startTimeout?: number
	retryBackoff?: number
}

export class CoordinationClient {
	#driver: Driver
	#nodeRuntime: CoordinationNodeRuntime

	constructor(driver: Driver) {
		this.#driver = driver
		this.#nodeRuntime = new CoordinationNodeRuntime(driver)
	}

	describeNode(path: string, signal?: AbortSignal): Promise<CoordinationNodeDescription> {
		return this.#nodeRuntime.describe(path, signal)
	}

	createNode(path: string, config: CoordinationNodeConfig, signal?: AbortSignal): Promise<void> {
		return this.#nodeRuntime.create(path, config, signal)
	}

	alterNode(path: string, config: CoordinationNodeConfig, signal?: AbortSignal): Promise<void> {
		return this.#nodeRuntime.alter(path, config, signal)
	}

	dropNode(path: string, signal?: AbortSignal): Promise<void> {
		return this.#nodeRuntime.drop(path, signal)
	}

	async createSession(
		path: string,
		options?: SessionOptions,
		signal?: AbortSignal
	): Promise<CoordinationSession> {
		if (signal?.aborted) {
			throw signal.reason
		}

		let session = new CoordinationSession(this.#driver, { path, ...options }, signal)

		try {
			await getSessionRuntime(session).waitReady(signal)
			return session
		} catch (error) {
			session.destroy(error)
			throw error
		}
	}

	async *openSession(
		path: string,
		options?: SessionOptions,
		signal?: AbortSignal
	): AsyncIterable<CoordinationSession> {
		for (;;) {
			if (signal?.aborted) {
				return
			}

			// oxlint-disable-next-line no-await-in-loop
			let session = await this.createSession(path, options, signal)
			yield session

			// oxlint-disable-next-line no-await-in-loop
			let shouldOpenNext = await shouldOpenNextSession(session, signal)
			if (!shouldOpenNext) {
				return
			}
		}
	}

	async withSession<T>(
		path: string,
		callback: (session: CoordinationSession) => Promise<T>,
		options?: SessionOptions,
		signal?: AbortSignal
	): Promise<T> {
		let session = await this.createSession(path, options, signal)

		try {
			return await callback(session)
		} finally {
			await session.close(signal)
		}
	}
}

let shouldOpenNextSession = async function shouldOpenNextSession(
	session: CoordinationSession,
	externalSignal?: AbortSignal
): Promise<boolean> {
	let deferred = Promise.withResolvers<any>()
	let combinedSignal = externalSignal
		? AbortSignal.any([session.signal, externalSignal])
		: session.signal

	combinedSignal.addEventListener('abort', deferred.resolve, { once: true })
	await deferred.promise

	if (externalSignal?.aborted) {
		return false
	}

	return session.status === 'expired'
}
