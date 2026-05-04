/**
 * Alternative SessionPool.
 *
 * Design notes (diverges from session-pool.ts):
 *   - Single source of truth: #all (Set). Idle is a derived LIFO stack.
 *   - Idle is LIFO for cache warmth (server-side plan cache).
 *   - Busy has no explicit marker — it's "in #all but not in #available".
 *   - No background sweeper. Dead sessions are evicted lazily on acquire.
 *   - Waiters have a hard cap (maxSize * 8) — caller gets fast failure
 *     under thundering-herd rather than unbounded queue growth.
 *   - An evicted session opens a slot; we proactively refill for waiters.
 *   - close() is atomic w.r.t. in-flight creates: we own their abort
 *     controllers, cancel them on close, and allSettle before returning.
 *
 * Memory-leak hygiene (important on Node <22.6 and Bun):
 *   - No AbortSignal.any anywhere. Every `abort`-listener we add is also
 *     explicitly removed on success paths (see #mergeSignals / detach()).
 *   - SessionLease mirrors session.signal into a *lease-scoped* controller
 *     so each acquire/release cycle attaches exactly one listener on the
 *     long-lived session signal and removes it on dispose. Otherwise a
 *     hot session serving N queries would accumulate N listeners.
 */

import { channel as dc, tracingChannel } from 'node:diagnostics_channel'

import { linkSignals } from '@ydbjs/abortable'
import type { Driver } from '@ydbjs/core'
import { loggers } from '@ydbjs/debug'
import { Session } from './session.js'

/** Reasons a session left the pool. See `ydb:session.closed`. */
type SessionClosedReason = 'evicted' | 'pool_close'

/** Call-site classifier for `tracing:ydb:session.acquire`. */
type SessionAcquireKind = 'query' | 'transaction'

export let sessionAcquireCh = tracingChannel<
	{ kind: SessionAcquireKind },
	{ kind: SessionAcquireKind }
>('tracing:ydb:session.acquire')

let sessionCreateCh = tracingChannel<
	{ liveSessions: number; maxSize: number; creating: number },
	{ liveSessions: number; maxSize: number; creating: number }
>('tracing:ydb:session.create')

let dbg = loggers.query.extend('pool2')

export class SessionPoolClosedError extends Error {
	constructor() {
		super('session pool is closed')
		this.name = 'SessionPoolClosedError'
	}
}

export class SessionPoolFullError extends Error {
	constructor(limit: number) {
		super(`session pool wait queue is full (limit=${limit})`)
		this.name = 'SessionPoolFullError'
	}
}

export type SessionPoolOptions = {
	/** Hard cap on simultaneously-live sessions (idle + busy + creating). */
	maxSize?: number
	/** Multiplier over maxSize for the wait queue. Default 8. */
	waitQueueFactor?: number
}

let DEFAULTS = {
	maxSize: 50,
	waitQueueFactor: 8,
} satisfies Required<SessionPoolOptions>

type Waiter = {
	resolve: (s: Session) => void
	reject: (e: Error) => void
	/** Detaches the external AbortSignal listener if any. */
	detach: () => void
}

/**
 * A lease's signal is NOT session.signal directly — it's a private
 * controller that mirrors session.signal for the lifetime of the lease.
 * When the lease is disposed, we explicitly detach from session.signal so
 * a hot session serving thousands of queries doesn't accrue thousands of
 * listeners. For merging further signals with `lease.signal` downstream,
 * use `linkSignals` (@ydbjs/abortable) — it cleans up on dispose, unlike
 * `AbortSignal.any` which leaks on Node <22.6 / Bun.
 */
export class SessionLease implements Disposable {
	#pool: SessionPool
	readonly session: Session
	#mirror = new AbortController()
	#detach: (() => void) | undefined

	constructor(pool: SessionPool, session: Session) {
		this.#pool = pool
		this.session = session

		if (session.signal.aborted) {
			this.#mirror.abort(session.signal.reason)
			return
		}

		let handler = () => this.#mirror.abort(session.signal.reason)
		session.signal.addEventListener('abort', handler, { once: true })
		this.#detach = () => session.signal.removeEventListener('abort', handler)
	}

	get id(): string {
		return this.session.id
	}
	get nodeId(): bigint {
		return this.session.nodeId
	}
	/** Aborts when the session dies. Lease-scoped: safe to chain further. */
	get signal(): AbortSignal {
		return this.#mirror.signal
	}

	[Symbol.dispose](): void {
		if (this.#detach) {
			this.#detach()
			this.#detach = undefined
		}
		this.#pool.release(this.session)
	}
}

export class SessionPool implements AsyncDisposable {
	#driver: Driver
	#maxSize: number
	#maxWaiters: number

	#all = new Set<Session>()
	#available: Session[] = [] // LIFO: pop from end, push to end
	#waiters: Waiter[] = [] // FIFO
	#creates = new Set<Promise<unknown>>()
	#close = new AbortController()

	// Per-session metadata used by `ydb:session.closed`. Held weakly so a
	// session removed from #all without going through #publishClosed (defence
	// in depth) doesn't keep its createdAt entry alive.
	#createdAt = new WeakMap<Session, number>()
	#evictionHandlers = new WeakMap<Session, () => void>()

	constructor(driver: Driver, options: SessionPoolOptions = {}) {
		this.#driver = driver
		this.#maxSize = options.maxSize ?? DEFAULTS.maxSize
		this.#maxWaiters = this.#maxSize * (options.waitQueueFactor ?? DEFAULTS.waitQueueFactor)
	}

	get closed(): boolean {
		return this.#close.signal.aborted
	}

	get stats() {
		return {
			total: this.#all.size,
			idle: this.#available.length,
			busy: this.#all.size - this.#available.length,
			creating: this.#creates.size,
			waiting: this.#waiters.length,
			maxSize: this.#maxSize,
		}
	}

	async acquire(signal?: AbortSignal): Promise<SessionLease> {
		let session = await this.#acquireSession(signal)
		return new SessionLease(this, session)
	}

	release(session: Session): void {
		// Session died while someone was using it. The eviction listener
		// already popped it from #all and published `closed{evicted}`; just
		// fire DeleteSession in the background.
		if (!session.alive || !this.#all.has(session)) {
			session.close()
			return
		}

		if (this.closed) {
			// Pool was closed between acquire() and release(); already-tracked
			// sessions get a `pool_close` event so subscribers see one event
			// per session lifecycle regardless of timing.
			this.#publishClosed(session, 'pool_close')
			this.#all.delete(session)
			session.close()
			return
		}

		session.lastUsedAt = Date.now()

		// Direct handoff: no bounce through #available.
		let waiter = this.#waiters.shift()
		if (waiter) {
			waiter.detach()
			waiter.resolve(session)
			return
		}

		this.#available.push(session)
	}

	async close(): Promise<void> {
		if (this.closed) return
		this.#close.abort(new SessionPoolClosedError())

		// Reject every waiter with a clear cause.
		let waiters = this.#waiters.splice(0)
		for (let w of waiters) {
			w.detach()
			w.reject(new SessionPoolClosedError())
		}

		// Only thing worth awaiting: in-flight Session.open calls. The
		// pool-close signal already propagated into them, so they'll bail
		// quickly. Once settled, nothing new can land in the pool.
		await Promise.allSettled([...this.#creates])

		let sessions = [...this.#all]
		this.#all.clear()
		this.#available.length = 0
		// close() is sync + fire-and-forget — no need to await each RPC.
		// Detach the eviction listener BEFORE close() so we don't double-fire
		// `closed{evicted}` for sessions that the pool itself is tearing down.
		for (let s of sessions) {
			this.#detachEviction(s)
			this.#publishClosed(s, 'pool_close')
			s.close()
		}
		dbg.log('pool closed (%d sessions)', sessions.length)
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close()
	}

	// --- internals -------------------------------------------------------

	async #acquireSession(signal?: AbortSignal): Promise<Session> {
		if (this.closed) throw new SessionPoolClosedError()
		signal?.throwIfAborted()

		// 1. Fast path: pop a warm idle session (LIFO). Skip dead ones lazily.
		while (this.#available.length > 0) {
			let candidate = this.#available.pop()!
			if (candidate.alive) return candidate
			this.#all.delete(candidate) // already reaped by eviction, belt & braces
		}

		// 2. Grow the pool if there's capacity.
		if (this.#all.size + this.#creates.size < this.#maxSize) {
			return this.#grow(signal)
		}

		// 3. Queue behind existing waiters.
		return this.#enqueue(signal)
	}

	async #grow(signal?: AbortSignal): Promise<Session> {
		// `using` auto-detaches listeners from every input (external + pool-
		// close) when the block exits — no accumulation on #close.signal as
		// many concurrent creates fan out.
		using linked = linkSignals(signal, this.#close.signal)

		let createCtx = {
			liveSessions: this.#all.size,
			maxSize: this.#maxSize,
			creating: this.#creates.size,
		}
		let promise = sessionCreateCh.tracePromise(
			() => Session.open(this.#driver, linked.signal),
			createCtx
		)
		this.#creates.add(promise)

		try {
			let session = await promise

			// The pool closed while we were creating. Dispose it, don't leak.
			if (this.closed) {
				session.close()
				throw new SessionPoolClosedError()
			}

			this.#all.add(session)
			this.#createdAt.set(session, Date.now())
			this.#bindEviction(session)
			dc('ydb:session.created').publish({
				sessionId: session.id,
				nodeId: session.nodeId,
			})
			return session
		} finally {
			this.#creates.delete(promise)
		}
	}

	#bindEviction(session: Session): void {
		let handler = () => {
			this.#evictionHandlers.delete(session)
			this.#all.delete(session)
			let idx = this.#available.indexOf(session)
			if (idx !== -1) this.#available.splice(idx, 1)
			dbg.log('evicted session %s', session.id)
			this.#publishClosed(session, 'evicted')
			this.#pumpWaitersAfterEviction()
		}
		this.#evictionHandlers.set(session, handler)
		session.signal.addEventListener('abort', handler, { once: true })
	}

	/**
	 * Detach the eviction listener bound by #bindEviction. Used by close()
	 * to avoid a double `closed` event when the pool itself tears down a
	 * session (which abort() would otherwise reflect back through the
	 * eviction listener).
	 */
	#detachEviction(session: Session): void {
		let handler = this.#evictionHandlers.get(session)
		if (!handler) return
		this.#evictionHandlers.delete(session)
		session.signal.removeEventListener('abort', handler)
	}

	#publishClosed(session: Session, reason: SessionClosedReason): void {
		let createdAt = this.#createdAt.get(session)
		let uptime = createdAt ? Date.now() - createdAt : 0
		this.#createdAt.delete(session)
		dc('ydb:session.closed').publish({
			sessionId: session.id,
			nodeId: session.nodeId,
			reason,
			uptime,
		})
	}

	/**
	 * An eviction just opened a slot. If any waiters are queued, spin up a
	 * replacement session for the oldest one. We only replace one session
	 * per eviction — if the caller's request fails, the next acquire will
	 * try again or another eviction will trigger another replacement.
	 */
	#pumpWaitersAfterEviction(): void {
		if (this.closed) return
		if (this.#waiters.length === 0) return
		if (this.#all.size + this.#creates.size >= this.#maxSize) return

		let waiter = this.#waiters.shift()!
		waiter.detach()
		this.#grow().then(
			(s) => waiter.resolve(s),
			(e) => waiter.reject(e instanceof Error ? e : new Error(String(e)))
		)
	}

	#enqueue(signal?: AbortSignal): Promise<Session> {
		if (this.#waiters.length >= this.#maxWaiters) {
			return Promise.reject(new SessionPoolFullError(this.#maxWaiters))
		}

		let { promise, resolve, reject } = Promise.withResolvers<Session>()

		let onAbort = () => {
			let idx = this.#waiters.findIndex((w) => w.resolve === resolve)
			if (idx !== -1) this.#waiters.splice(idx, 1)
			reject(signal!.reason ?? new Error('aborted'))
		}

		let detach = signal ? () => signal.removeEventListener('abort', onAbort) : () => {}

		if (signal) signal.addEventListener('abort', onAbort, { once: true })

		this.#waiters.push({ resolve, reject, detach })
		return promise
	}
}
