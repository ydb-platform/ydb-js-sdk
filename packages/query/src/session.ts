/**
 * Alternative Session: lifecycle is driven by a single AbortSignal.
 *
 *   alive      -> signal.aborted === false
 *   broken     -> signal.aborted === true
 *
 * No BUSY/IDLE state on the session itself — that belongs to the pool.
 * A session entering the pool is guaranteed to be attached; if attach
 * fails during `Session.open`, the server-side session is deleted
 * before the error propagates to the caller. No leaks.
 */

import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { QueryServiceDefinition, type SessionState } from '@ydbjs/api/query'
import type { Driver } from '@ydbjs/core'
import { loggers } from '@ydbjs/debug'
import { YDBError } from '@ydbjs/error'

let dbg = loggers.query.extend('session')

export class SessionAbortedError extends Error {
	readonly sessionId: string
	readonly reason: 'stream-closed' | 'stream-error' | 'deleted' | 'pool-closed'

	constructor(sessionId: string, reason: SessionAbortedError['reason']) {
		super(`session ${sessionId} aborted: ${reason}`)
		this.name = 'SessionAbortedError'
		this.sessionId = sessionId
		this.reason = reason
	}
}

export class Session {
	readonly id: string
	readonly nodeId: bigint
	lastUsedAt: number = Date.now()

	#driver: Driver
	#life = new AbortController()
	#attach = new AbortController()
	#closing = false

	private constructor(driver: Driver, id: string, nodeId: bigint) {
		this.#driver = driver
		this.id = id
		this.nodeId = nodeId
	}

	/** Fires as soon as the session is known unusable. Stays aborted forever after. */
	get signal(): AbortSignal {
		return this.#life.signal
	}

	get alive(): boolean {
		return !this.#life.signal.aborted
	}

	/**
	 * Create a session on the server and bind an attachSession stream to it.
	 * On attach failure, DeleteSession is fired and forgotten — the caller
	 * doesn't pay latency for cleanup, and if the RPC fails the server-side
	 * TTL reaps the session anyway.
	 */
	static async open(driver: Driver, signal?: AbortSignal): Promise<Session> {
		let bootstrap = driver.createClient(QueryServiceDefinition)
		let resp = await bootstrap.createSession({}, signal ? { signal } : {})
		if (resp.status !== StatusIds_StatusCode.SUCCESS) {
			throw new YDBError(resp.status, resp.issues)
		}

		let session = new Session(driver, resp.sessionId, resp.nodeId)
		try {
			await session.#bindAttach(signal)
			return session
		} catch (err) {
			dbg.log('attach failed for %s, firing DeleteSession in background', session.id)
			session.#attach.abort() // defensive: ensure stream is torn down
			session.#deleteOnServer() // fire-and-forget
			throw err
		}
	}

	async #bindAttach(signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted()

		// Forward external cancellation into our attach controller so the
		// gRPC stream is torn down as soon as the caller aborts. `detach`
		// is only set when we actually subscribed, so we can't accidentally
		// remove a listener that was never added.
		let detach: (() => void) | undefined
		if (signal) {
			let handler = () => this.#attach.abort(signal.reason)
			signal.addEventListener('abort', handler, { once: true })
			detach = () => signal.removeEventListener('abort', handler)
		}

		try {
			let client = this.#driver.createClient(QueryServiceDefinition, this.nodeId)
			let stream = client.attachSession(
				{ sessionId: this.id },
				{ signal: this.#attach.signal }
			)
			let iterator = stream[Symbol.asyncIterator]()

			let first = await iterator.next()
			if (first.done) {
				throw new YDBError(StatusIds_StatusCode.BAD_SESSION, [])
			}
			if (first.value.status !== StatusIds_StatusCode.SUCCESS) {
				throw new YDBError(first.value.status, first.value.issues)
			}

			dbg.log('attached session %s on node %d', this.id, this.nodeId)
			this.#runMonitor(stream).catch(() => {})
		} finally {
			detach?.()
		}
	}

	/**
	 * Drives the attach stream until it closes or errors. `for await` on
	 * break/throw auto-calls the iterator's `return()`, which cancels the
	 * underlying gRPC call — no dangling stream.
	 */
	async #runMonitor(stream: AsyncIterable<SessionState>): Promise<void> {
		let reason: SessionAbortedError['reason'] = 'stream-closed'
		try {
			for await (let msg of stream) {
				if (msg.status !== StatusIds_StatusCode.SUCCESS) {
					reason = 'stream-error'
					break
				}
			}
		} catch {
			reason = 'stream-error'
		} finally {
			this.#markBroken(reason)
		}
	}

	#markBroken(reason: SessionAbortedError['reason']): void {
		if (this.#life.signal.aborted) return
		this.#life.abort(new SessionAbortedError(this.id, reason))
		this.#attach.abort()
		dbg.log('session %s marked broken (%s)', this.id, reason)
	}

	/** Fire-and-forget DeleteSession. Server TTL is the ultimate backstop. */
	#deleteOnServer(): void {
		let client = this.#driver.createClient(QueryServiceDefinition, this.nodeId)
		client.deleteSession({ sessionId: this.id }).catch((err) => {
			dbg.log('deleteSession for %s failed: %O', this.id, err)
		})
	}

	/**
	 * Synchronous shutdown: flip state, fire DeleteSession in the
	 * background. Callers never wait on the RPC.
	 */
	close(): void {
		if (this.#closing) return
		this.#closing = true
		if (this.alive) this.#deleteOnServer()
		this.#markBroken('deleted')
	}

	[Symbol.dispose](): void {
		this.close()
	}
}
