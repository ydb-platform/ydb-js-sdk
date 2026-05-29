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

import { tracingChannel } from 'node:diagnostics_channel'

import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { QueryServiceDefinition, type SessionState } from '@ydbjs/api/query'
import type { Driver, DriverIdentity } from '@ydbjs/core'
import { loggers } from '@ydbjs/debug'
import { YDBError } from '@ydbjs/error'

/**
 * Why a session left the server. Carried on
 * `tracing:ydb:query.session.delete` and `ydb:query.session.closed`.
 *
 * Only three real causes exist; `stream_closed` and `stream_error` split the
 * post-attach death by whether the server closed cleanly or the stream
 * errored, which subscribers care about for alerting.
 *
 *   - 'pool_close'    — pool is tearing down; we tell the server.
 *   - 'attach_failed' — initial AttachStream rejected; session never lived.
 *   - 'stream_closed' — attach stream ended cleanly (server-side timeout / drain).
 *   - 'stream_error' — attach stream errored mid-flight.
 *
 * No `user_close` — users do not manage sessions. No `evicted` /
 * `release_dead` — those were pool-side observations of stream death, the
 * underlying `stream_*` reason now propagates through.
 */
export type SessionCloseReason = 'pool_close' | 'attach_failed' | 'stream_closed' | 'stream_error'

type SessionDeleteCtx = {
	driver: DriverIdentity
	sessionId: string
	nodeId: bigint
	reason: SessionCloseReason
	/** ms */
	uptime: number
}

export let sessionDeleteCh = tracingChannel<SessionDeleteCtx, SessionDeleteCtx>(
	'tracing:ydb:query.session.delete'
)

let dbg = loggers.query.extend('session')

export class SessionAbortedError extends Error {
	readonly sessionId: string
	readonly reason: SessionCloseReason

	constructor(sessionId: string, reason: SessionCloseReason) {
		super(`session ${sessionId} aborted: ${reason}`)
		this.name = 'SessionAbortedError'
		this.sessionId = sessionId
		this.reason = reason
	}
}

/**
 * Thrown when an RPC is started against a session that already has an in-flight
 * RPC. YDB processes RPCs on a session sequentially, so concurrent statements
 * on the same session would otherwise block on a server-side lock.
 */
export class SessionBusyError extends Error {
	readonly sessionId: string

	constructor(sessionId: string) {
		super(
			`session ${sessionId} is already executing another RPC. ` +
				`YDB sessions are single-threaded; await the previous statement before starting a new one.`
		)
		this.name = 'SessionBusyError'
		this.sessionId = sessionId
	}
}

export class Session {
	readonly id: string
	readonly nodeId: bigint
	readonly createdAt: number = Date.now()
	lastUsedAt: number = Date.now()

	#driver: Driver
	#life = new AbortController()
	#attach = new AbortController()
	#closing = false
	#closeReason: SessionCloseReason | undefined
	// In-flight RPCs on this session. YDB sessions are single-threaded, so
	// this counter must never exceed 1. `claim()` throws SessionBusyError on
	// the second concurrent caller.
	#inflight = 0

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
	 * The reason this session was closed, set by `#markBroken` (stream monitor
	 * or pool tear-down). Stays `undefined` while the session is alive.
	 * Pool subscribers read it from the eviction listener so the published
	 * `session.closed` event reflects the underlying cause, not the pool's
	 * view of it.
	 */
	get closeReason(): SessionCloseReason | undefined {
		return this.#closeReason
	}

	/**
	 * Mark the session as serving an RPC. Throws SessionBusyError if another
	 * RPC is already in flight on this session. The returned `Disposable`
	 * releases the slot on dispose; pair every `claim()` with `using` or an
	 * explicit dispose.
	 */
	claim(): Disposable {
		if (this.#inflight > 0) {
			throw new SessionBusyError(this.id)
		}
		this.#inflight++
		let released = false
		return {
			[Symbol.dispose]: () => {
				if (released) return
				released = true
				this.#inflight = Math.max(0, this.#inflight - 1)
			},
		}
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
			session.#deleteOnServer('attach_failed') // fire-and-forget
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
		let reason: SessionCloseReason = 'stream_closed'
		try {
			for await (let msg of stream) {
				if (msg.status !== StatusIds_StatusCode.SUCCESS) {
					reason = 'stream_error'
					break
				}
			}
		} catch {
			reason = 'stream_error'
		} finally {
			this.#markBroken(reason)
		}
	}

	#markBroken(reason: SessionCloseReason): void {
		if (this.#life.signal.aborted) return
		this.#closeReason = reason
		this.#life.abort(new SessionAbortedError(this.id, reason))
		this.#attach.abort()
		dbg.log('session %s marked broken (%s)', this.id, reason)
	}

	// Fire-and-forget RPC, traced for subscribers. Server TTL cleans up if
	// the call is lost.
	#deleteOnServer(reason: SessionCloseReason): void {
		let client = this.#driver.createClient(QueryServiceDefinition, this.nodeId)
		let ctx: SessionDeleteCtx = {
			driver: this.#driver.identity,
			sessionId: this.id,
			nodeId: this.nodeId,
			reason,
			uptime: Date.now() - this.createdAt,
		}
		sessionDeleteCh
			.tracePromise(() => client.deleteSession({ sessionId: this.id }), ctx)
			.catch((err) => {
				dbg.log('deleteSession for %s failed: %O', this.id, err)
			})
	}

	/**
	 * Synchronous shutdown: flip state, fire DeleteSession in the
	 * background. Callers never wait on the RPC. Reason is required —
	 * the pool always knows why it's tearing a session down, and there's
	 * no sensible default in the absence of `user_close`.
	 */
	close(reason: SessionCloseReason): void {
		if (this.#closing) return
		this.#closing = true
		if (this.alive) this.#deleteOnServer(reason)
		this.#markBroken(reason)
	}
}
