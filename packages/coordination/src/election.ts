import { abortable } from '@ydbjs/abortable'
import { loggers } from '@ydbjs/debug'
import { once } from 'node:events'

import type { CoordinationSession } from './session.js'
import type { SessionOptions } from './index.js'

let dbg = loggers.driver.extend('coordination').extend('election')

/**
 * Options for participating in leader election
 */
export interface ElectionOptions {
	/**
	 * Data to attach when acquiring leadership (e.g., endpoint, node ID)
	 * This data will be visible to all participants as leader.data
	 */
	data: Uint8Array

	/**
	 * AbortSignal to stop participating in election
	 * When aborted, releases leadership (if held) and stops watching
	 */
	signal?: AbortSignal

	/**
	 * Session options (recoveryWindowMs, description)
	 */
	sessionOptions?: SessionOptions

	/**
	 * Whether to create ephemeral semaphore (auto-created on first acquire, auto-deleted on last release)
	 * Default: true
	 */
	ephemeral?: boolean
}

/**
 * Current state of leader election
 */
export interface LeaderState {
	/**
	 * Data attached by the current leader (e.g., endpoint)
	 */
	data: Uint8Array

	/**
	 * True if this node is the current leader
	 */
	isMe: boolean

	/**
	 * AbortSignal that aborts when leadership changes
	 * - For leaders: aborts when losing leadership
	 * - For followers: aborts when a new leader is elected
	 */
	signal: AbortSignal
}

/**
 * Creates an async iterable for leader election
 *
 * All nodes participate in election by trying to acquire a semaphore with limit=1.
 * Only one node becomes leader at a time. All nodes watch the semaphore to know
 * who the current leader is.
 *
 * @param sessionFactory - Function to create coordination session
 * @param path - Path to coordination node
 * @param name - Name of the semaphore for election
 * @param options - Election options including data and signal
 * @returns AsyncIterable that yields LeaderState on each leader change
 *
 * @example
 * ```typescript
 * let election = election(sessionFactory, '/local/node', 'my-service', {
 *   data: new TextEncoder().encode('host1:8080'),
 *   signal: controller.signal
 * })
 *
 * for await (let leader of election) {
 *   if (leader.isMe) {
 *     await doLeaderWork(leader.signal)
 *   } else {
 *     console.log('Leader:', new TextDecoder().decode(leader.data))
 *   }
 * }
 * ```
 */
export async function* election(
	session: CoordinationSession,
	name: string,
	options: ElectionOptions
): AsyncIterable<LeaderState> {
	dbg.log('starting election for semaphore: %s', name)

	let currentLeader: LeaderState | null = null
	let currentController: AbortController | null = null
	let leaderResolve: (() => void) | null = null

	// AbortController for internal cleanup
	let internalAbort = new AbortController()

	let combinedSignal = options.signal
		? AbortSignal.any([options.signal, internalAbort.signal])
		: internalAbort.signal

	// Abort current leader signal when election is aborted
	combinedSignal.addEventListener(
		'abort',
		() => {
			if (currentController && !currentController.signal.aborted) {
				dbg.log('aborting leader signal due to election abort')
				currentController.abort()
			}
		},
		{ once: true }
	)

	function updateLeader(leader: LeaderState, controller: AbortController) {
		if (currentController && !currentController.signal.aborted) {
			dbg.log('aborting previous leader signal')
			currentController.abort()
		}

		currentLeader = leader
		currentController = controller
		dbg.log(
			'new leader: isMe=%s, data=%s',
			leader.isMe,
			new TextDecoder().decode(leader.data)
		)

		if (leaderResolve) {
			leaderResolve()
			leaderResolve = null
		}
	}

	function waitForLeader(): Promise<void> {
		if (currentLeader) {
			return Promise.resolve()
		}

		return abortable(
			combinedSignal,
			new Promise((resolve) => {
				leaderResolve = resolve
			})
		)
	}

	// Task A: Try to acquire leadership
	let acquireTask = (async () => {
		while (!combinedSignal.aborted) {
			try {
				dbg.log('attempting to acquire leadership')
				// eslint-disable-next-line no-await-in-loop
				await using lock = await session.acquire(
					name,
					{
						count: 1,
						timeoutMillis: Infinity,
						data: options.data,
						ephemeral: options.ephemeral ?? true,
					},
					combinedSignal
				)

				dbg.log('acquired leadership')

				// Wait until lock is lost or signal is aborted
				let releaseSignal = AbortSignal.any([
					combinedSignal,
					lock.signal,
				])

				if (!releaseSignal.aborted) {
					// eslint-disable-next-line no-await-in-loop
					await once(releaseSignal, 'abort')
				}

				dbg.log('lock lost or aborted, will retry acquire')
			} catch (error) {
				dbg.log('acquire failed, will retry: %O', error)
			}
		}
	})()

	let fatalError: unknown = null

	// Task B: Watch for leader changes
	let watchTask = (async () => {
		try {
			dbg.log('starting watch for owners')
			for await (let desc of session.watch(
				name,
				{ owners: true },
				combinedSignal
			)) {
				let owner = desc.owners?.[0]
				if (!owner) {
					dbg.log('no leader found in semaphore')
					continue
				}

				let isMe = owner.sessionId === session.sessionId
				dbg.log(
					'watch event: owner.sessionId=%s, my session.sessionId=%s, isMe=%s, data=%s',
					owner.sessionId,
					session.sessionId,
					isMe,
					new TextDecoder().decode(owner.data)
				)

				let abortController = new AbortController()

				let leader: LeaderState = {
					data: owner.data,
					isMe,
					signal: abortController.signal,
				}

				updateLeader(leader, abortController)
			}
		} catch (error) {
			if (!combinedSignal.aborted) {
				dbg.log('watch task error: %O', error)
				fatalError = error
				internalAbort.abort()
			} else {
				dbg.log('watch task aborted')
			}
		}
	})()

	try {
		while (!combinedSignal.aborted) {
			if (currentLeader) {
				let leader = currentLeader
				currentLeader = null
				yield leader
			}

			// eslint-disable-next-line no-await-in-loop
			await waitForLeader()
		}
	} catch (error) {
		if (fatalError) {
			throw fatalError
		} else if (error instanceof Error && error.name === 'AbortError') {
			dbg.log('election aborted via signal')
		} else {
			throw error
		}
	} finally {
		dbg.log('election cleanup started')

		// Signal tasks to stop
		internalAbort.abort()

		// Wait for tasks to complete
		await Promise.allSettled([acquireTask, watchTask])

		dbg.log('election cleanup completed')
	}
}
