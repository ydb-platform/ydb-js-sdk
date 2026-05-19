/**
 * Alternative SessionPool.
 *
 * Design notes (diverges from session-pool.ts):
 *   - Single source of truth: #all (Set). Idle is a derived LIFO stack.
 *   - Idle is LIFO for cache warmth (server-side plan cache).
 *   - Busy has no explicit marker — it's "in #all but not in #available".
 *   - No background sweeper. Dead sessions are dropped lazily on acquire.
 *   - Waiters have a hard cap (maxSize * 8) — caller gets fast failure
 *     under thundering-herd rather than unbounded queue growth.
 *   - A dropped session opens a slot; we proactively refill for waiters.
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
import type { Driver, DriverIdentity } from '@ydbjs/core'
import { loggers } from '@ydbjs/debug'
import { Session, type SessionCloseReason } from './session.js'

type SessionAcquireCtx = { driver: DriverIdentity }
type SessionCreateCtx = { driver: DriverIdentity }

let sessionCreateCh = tracingChannel<SessionCreateCtx, SessionCreateCtx>(
	'tracing:ydb:query.session.create'
)

export let sessionAcquireCh = tracingChannel<SessionAcquireCtx, SessionAcquireCtx>(
	'tracing:ydb:query.session.acquire'
)

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
	/**
	 * Soft floor reported as `ydb.query.session.min` for dashboard parity
	 * with other YDB SDKs. The JS pool does not eagerly warm sessions up to
	 * this number. Default 0.
	 */
	minSize?: number
	/** Multiplier over maxSize for the wait queue. Default 8. */
	waitQueueFactor?: number
}

let DEFAULTS = {
	maxSize: 50,
	minSize: 0,
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
	#minSize: number
	#maxWaiters: number

	#all = new Set<Session>()
	#available: Session[] = [] // LIFO: pop from end, push to end
	#waiters: Waiter[] = [] // FIFO
	#creates = new Set<Promise<unknown>>()
	#close = new AbortController()

	#evictionHandlers = new WeakMap<Session, () => void>()

	constructor(driver: Driver, options: SessionPoolOptions = {}) {
		this.#driver = driver
		this.#maxSize = options.maxSize ?? DEFAULTS.maxSize
		this.#minSize = options.minSize ?? DEFAULTS.minSize
		this.#maxWaiters = this.#maxSize * (options.waitQueueFactor ?? DEFAULTS.waitQueueFactor)

		if (this.#minSize > this.#maxSize) {
			throw new RangeError(
				`minSize (${this.#minSize}) cannot exceed maxSize (${this.#maxSize})`
			)
		}

		// Single config snapshot for this pool. Metrics subscribers anchor
		// their per-pool ObservableGauges here; per-session events deliberately
		// do not repeat config.
		dc('ydb:query.session.pool.opened').publish({
			driver: this.#driver.identity,
			maxSize: this.#maxSize,
			minSize: this.#minSize,
			maxWaiters: this.#maxWaiters,
		})

		this.#refillToMinSize()
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
			minSize: this.#minSize,
		}
	}

	async acquire(signal?: AbortSignal): Promise<SessionLease> {
		try {
			let session = await this.#acquireSession(signal)

			dc('ydb:query.session.acquired').publish({
				driver: this.#driver.identity,
				nodeId: session.nodeId,
				sessionId: session.id,
			})

			return new SessionLease(this, session)
		} catch (error) {
			// Caller cancellation isn't a pool-side failure — the request was
			// withdrawn before we could serve it. Skip the failed event so the
			// `acquire.failures` counter stays a pool-health signal rather than
			// a count of upstream-cancelled requests. Pool-internal aborts
			// (pool.close, full queue, timeout we picked) still publish.
			if (!signal?.aborted) {
				dc('ydb:query.session.acquire.failed').publish({
					driver: this.#driver.identity,
					error,
				})
			}

			throw error
		}
	}

	release(session: Session): void {
		// Pairs with `ydb:query.session.acquired`: exactly one release per
		// lease, whatever path the session takes afterwards.
		dc('ydb:query.session.released').publish({
			driver: this.#driver.identity,
			nodeId: session.nodeId,
			sessionId: session.id,
		})

		// Session died while someone was using it. The eviction listener
		// already popped it from #all and published `closed{stream_*}`. The
		// server has either killed the session itself (stream_closed) or the
		// stream errored — either way the server-side TTL reaps it, so no
		// extra DeleteSession RPC is required from us.
		if (!session.alive || !this.#all.has(session)) {
			return
		}

		if (this.closed) {
			// Pool was closed between acquire() and release(); already-tracked
			// sessions get a `pool_close` event so subscribers see one event
			// per session lifecycle regardless of timing. Detach the eviction
			// listener first — session.close() aborts the signal, which would
			// otherwise re-fire `closed{stream_*}` for the same session.
			this.#detachEviction(session)
			this.#publishClosed(session, 'pool_close')
			this.#all.delete(session)

			session.close('pool_close')

			return
		}

		session.lastUsedAt = Date.now()

		// Direct handoff: no bounce through #available.
		let waiter = this.#waiters.shift()
		if (waiter) {
			waiter.detach()

			dc('ydb:query.session.waiter.dequeued').publish({
				driver: this.#driver.identity,
			})

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

			dc('ydb:query.session.waiter.dequeued').publish({
				driver: this.#driver.identity,
			})

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
		// `closed{stream_*}` for sessions that the pool itself is tearing down.
		for (let s of sessions) {
			this.#detachEviction(s)
			this.#publishClosed(s, 'pool_close')
			s.close('pool_close')
		}
		// Pairs with `pool.opened`; tells subscribers to drop per-pool state.
		dc('ydb:query.session.pool.closed').publish({ driver: this.#driver.identity })
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

		let createCtx: SessionCreateCtx = { driver: this.#driver.identity }
		let promise = sessionCreateCh.tracePromise(
			() => Session.open(this.#driver, linked.signal),
			createCtx
		)
		this.#creates.add(promise)

		try {
			let session = await promise

			// The pool closed while we were creating. Dispose it, don't leak.
			if (this.closed) {
				session.close('pool_close')
				throw new SessionPoolClosedError()
			}

			this.#all.add(session)
			this.#bindEviction(session)
			dc('ydb:query.session.created').publish({
				driver: this.#driver.identity,
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
			// Session.#markBroken set closeReason before aborting the signal;
			// fall back to stream_closed only as a defensive default if a
			// future code path aborts the signal without going through
			// markBroken (today nothing does).
			let reason = session.closeReason ?? 'stream_closed'
			dbg.log('session %s left the pool (%s)', session.id, reason)
			this.#publishClosed(session, reason)
			// Order matters: waiters first (the freed capacity belongs to
			// whoever was already queued), then top up to minSize if the
			// slot is still empty.
			this.#pumpWaitersAfterEviction()
			this.#refillToMinSize()
		}
		this.#evictionHandlers.set(session, handler)
		session.signal.addEventListener('abort', handler, { once: true })
	}

	/**
	 * Detach the eviction listener bound by #bindEviction. Used by close()
	 * to avoid a double `closed` event when the pool itself tears down a
	 * session (which abort() would otherwise reflect back through the
	 * eviction listener with reason=stream_*).
	 */
	#detachEviction(session: Session): void {
		let handler = this.#evictionHandlers.get(session)
		if (!handler) return
		this.#evictionHandlers.delete(session)
		session.signal.removeEventListener('abort', handler)
	}

	#publishClosed(session: Session, reason: SessionCloseReason): void {
		dc('ydb:query.session.closed').publish({
			driver: this.#driver.identity,
			sessionId: session.id,
			nodeId: session.nodeId,
			reason,
			uptime: Date.now() - session.createdAt,
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
		dc('ydb:query.session.waiter.dequeued').publish({ driver: this.#driver.identity })
		this.#grow().then(
			(s) => waiter.resolve(s),
			(e) => waiter.reject(e instanceof Error ? e : new Error(String(e)))
		)
	}

	/**
	 * Brings (live + in-flight creates) up to minSize. Called from the
	 * constructor and after every eviction. Idempotent: computes the deficit
	 * each time, so over-calling is harmless. Each grow runs concurrently
	 * via a detached `#growAndPark`; the outer call returns immediately.
	 */
	#refillToMinSize(): void {
		if (this.closed) return
		let deficit = this.#minSize - (this.#all.size + this.#creates.size)
		for (let i = 0; i < deficit; i++) {
			void this.#growAndPark()
		}
	}

	/**
	 * Grow once, then park the result: hand to a queued waiter if any,
	 * otherwise drop into `#available` for the next acquire().
	 *
	 * Errors are swallowed by design — warm-up is best-effort. A failed
	 * background create does not crash the app; the next acquire() or the
	 * next eviction-triggered refill will try again. `SessionPoolClosedError`
	 * is expected on shutdown (the linked close signal aborts pending
	 * creates).
	 */
	async #growAndPark(): Promise<void> {
		let session: Session
		try {
			session = await this.#grow()
		} catch (err) {
			dbg.log('warm-up grow failed: %O', err)
			return
		}

		if (this.closed) return // #grow already disposed it under this.closed

		let waiter = this.#waiters.shift()
		if (waiter) {
			waiter.detach()
			dc('ydb:query.session.waiter.dequeued').publish({
				driver: this.#driver.identity,
			})
			waiter.resolve(session)
			return
		}

		this.#available.push(session)
	}

	#enqueue(signal?: AbortSignal): Promise<Session> {
		if (this.#waiters.length >= this.#maxWaiters) {
			return Promise.reject(new SessionPoolFullError(this.#maxWaiters))
		}

		let { promise, resolve, reject } = Promise.withResolvers<Session>()
		let driver = this.#driver.identity

		let onAbort = () => {
			let idx = this.#waiters.findIndex((w) => w.resolve === resolve)
			if (idx !== -1) {
				this.#waiters.splice(idx, 1)
				dc('ydb:query.session.waiter.dequeued').publish({ driver })
			}
			reject(signal!.reason ?? new Error('aborted'))
		}

		let detach = signal ? () => signal.removeEventListener('abort', onAbort) : () => {}

		if (signal) signal.addEventListener('abort', onAbort, { once: true })

		this.#waiters.push({ resolve, reject, detach })
		dc('ydb:query.session.waiter.enqueued').publish({ driver })
		return promise
	}
}
