import { channel as dc, tracingChannel } from 'node:diagnostics_channel'
import { AsyncLocalStorage } from 'node:async_hooks'

import { linkSignals } from '@ydbjs/abortable'
import type { Driver, DriverIdentity } from '@ydbjs/core'
import { type MachineRuntime, createMachineRuntime } from '@ydbjs/fsm'

import { Session } from './session.js'
import {
	type PoolCommand,
	type PoolContext,
	type PoolEvent,
	type PoolState,
	finishPoolOperation,
	poolContext,
	reservePoolOperation,
	transitionPool,
} from './session-pool-state.js'

type SessionAcquireCtx = { driver: DriverIdentity }
type SessionCreateCtx = { driver: DriverIdentity }

let sessionCreateCh = tracingChannel<SessionCreateCtx, SessionCreateCtx>(
	'tracing:ydb:query.session.create'
)
export let sessionAcquireCh = tracingChannel<SessionAcquireCtx, SessionAcquireCtx>(
	'tracing:ydb:query.session.acquire'
)

export class SessionPoolClosedError extends Error {
	constructor() {
		super('session pool is closed')
		this.name = 'SessionPoolClosedError'
	}
}

export class SessionPoolFullError extends Error {
	constructor(limit: number, operations = false) {
		super(
			operations
				? `session pool operation limit reached (limit=${limit})`
				: `session pool wait queue is full (limit=${limit})`
		)
		this.name = 'SessionPoolFullError'
	}
}

export type SessionPoolOptions = {
	/** Hard cap on simultaneously-live sessions (idle + busy + creating). */
	maxSize?: number
	/** Target number of sessions warmed in the background. Default 0; warm-up is best-effort. */
	minSize?: number
	/** Multiplier over maxSize for the wait queue. Default 8. */
	waitQueueFactor?: number
}

export class SessionLease implements Disposable {
	#pool: SessionPool
	readonly session: Session
	#mirror = new AbortController()
	#detach: (() => void) | undefined
	#released = false

	constructor(pool: SessionPool, session: Session) {
		this.#pool = pool
		this.session = session
		if (session.signal.aborted) {
			this.#mirror.abort(session.signal.reason)
			return
		}
		// Subscribers belong to this lease, not to the reusable session signal.
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
	get signal(): AbortSignal {
		return this.#mirror.signal
	}

	[Symbol.dispose](): void {
		if (this.#released) return
		this.#released = true
		this.#detach?.()
		this.#detach = undefined
		this.#pool.release(this.session)
	}
}

type Acquisition = {
	signal: AbortSignal | undefined
	enter: ReturnType<typeof AsyncLocalStorage.snapshot> | undefined
	resolve: (lease: SessionLease) => void
	reject: (error: unknown) => void
	detach: () => void
}
type PoolEffect = { type: 'apply'; commands: PoolCommand[] }

export class SessionPool implements AsyncDisposable, Disposable {
	#driver: Driver
	#machine: MachineRuntime<PoolState, PoolContext, PoolEvent, never>
	#requests = new Map<number, Acquisition>()
	#nextRequest = 0
	#sessions = new Map<number, Session>()
	#identities = new WeakMap<Session, number>()
	#listeners = new Map<number, () => void>()
	#creates = new Map<number, AbortController>()
	#stop = new AbortController()
	#emergency = new AbortController()
	#closedError = new SessionPoolClosedError()
	#full = Symbol('pool full')
	#shutdown: ReturnType<typeof Promise.withResolvers<void>> | undefined

	constructor(driver: Driver, options: SessionPoolOptions = {}) {
		this.#driver = driver
		let maxSize = options.maxSize ?? 50
		let minSize = options.minSize ?? 0
		let factor = options.waitQueueFactor ?? 8
		if (!Number.isSafeInteger(maxSize) || maxSize <= 0)
			throw new RangeError('maxSize must be a positive safe integer')
		if (!Number.isSafeInteger(minSize) || minSize < 0)
			throw new RangeError('minSize must be a non-negative safe integer')
		if (!Number.isFinite(factor) || factor < 0)
			throw new RangeError('waitQueueFactor must be a finite non-negative number')
		let maxWaiters = Math.ceil(maxSize * factor)
		if (!Number.isSafeInteger(maxWaiters) || !Number.isSafeInteger(maxSize + maxWaiters))
			throw new RangeError('Session pool admission capacity exceeds the safe integer range')
		if (minSize > maxSize)
			throw new RangeError(`minSize (${minSize}) cannot exceed maxSize (${maxSize})`)
		this.#machine = createMachineRuntime<
			PoolState,
			PoolContext,
			{},
			PoolEvent,
			PoolEffect,
			never
		>({
			initialState: 'starting',
			ctx: poolContext(maxSize, minSize, maxWaiters),
			env: {},
			transition: (context, event, runtime) => {
				let next = transitionPool(
					context,
					runtime.state,
					event,
					this.#closedError,
					this.#full
				)
				return {
					state: next.state,
					...(next.commands.length
						? { effects: [{ type: 'apply' as const, commands: next.commands }] }
						: {}),
					...(next.final ? { final: {} } : {}),
				}
			},
			effects: {
				apply: (_context, effect) => {
					this.#apply(effect.commands)
				},
			},
		})
		this.#machine.dispatch({ type: 'start' })
	}

	get closed(): boolean {
		return this.#shutdown !== undefined
	}
	get signal(): AbortSignal {
		return this.#stop.signal
	}

	beginOperation(continuingOperation = false): void {
		this.signal.throwIfAborted()
		let context = this.#machine.ctx
		let rejected = reservePoolOperation(context, continuingOperation, this.closed)
		if (rejected === 'closed') throw this.#closedError
		if (rejected === 'full')
			throw new SessionPoolFullError(context.maxSize + context.maxWaiters, true)
	}

	endOperation(continuingOperation = false): void {
		finishPoolOperation(this.#machine.ctx, continuingOperation)
		this.#machine.dispatch({ type: 'progress' })
	}

	get stats() {
		let context = this.#machine.ctx
		let stopped = this.#emergency.signal.aborted
		return {
			total: stopped ? 0 : context.sessions.size,
			idle: stopped ? 0 : context.idle.length,
			busy: stopped ? 0 : context.sessions.size - context.idle.length,
			creating: stopped ? 0 : context.creates.size,
			waiting: stopped ? 0 : context.waiters.size,
			maxSize: context.maxSize,
			minSize: context.minSize,
		}
	}

	async acquire(signal?: AbortSignal): Promise<SessionLease> {
		try {
			this.signal.throwIfAborted()
			signal?.throwIfAborted()
			let request = this.#nextRequest++
			let deferred = Promise.withResolvers<SessionLease>()
			let onAbort = () =>
				this.#machine.dispatch({ type: 'cancel', request, reason: signal!.reason })
			let observed =
				sessionCreateCh.hasSubscribers ||
				sessionCreateCh.start.hasSubscribers ||
				sessionCreateCh.end.hasSubscribers ||
				sessionCreateCh.asyncStart.hasSubscribers ||
				sessionCreateCh.asyncEnd.hasSubscribers ||
				sessionCreateCh.error.hasSubscribers ||
				this.#driver.options.hooks?.onCall
			this.#requests.set(request, {
				signal,
				enter: observed ? AsyncLocalStorage.snapshot() : undefined,
				resolve: deferred.resolve,
				reject: deferred.reject,
				detach: () => signal?.removeEventListener('abort', onAbort),
			})
			signal?.addEventListener('abort', onAbort, { once: true })
			this.#machine.dispatch({ type: 'acquire', request })
			return await deferred.promise
		} catch (error) {
			if (!signal?.aborted)
				dc('ydb:query.session.acquire.failed').publish({
					driver: this.#driver.identity,
					error,
				})
			throw error
		}
	}

	release(session: Session): void {
		let identity = this.#identities.get(session)
		if (identity === undefined) return
		this.#machine.dispatch({
			type: 'release',
			session: identity,
			serverId: session.id,
			nodeId: session.nodeId,
		})
	}

	close(): Promise<void> {
		if (this.#shutdown) return this.#shutdown.promise
		// Reentrant diagnostics can request shutdown while the actor is applying effects.
		// The promise is the synchronous admission fence until that queued event is reduced.
		this.#shutdown = Promise.withResolvers<void>()
		this.#machine.dispatch({ type: 'close' })
		return this.#shutdown.promise
	}

	destroy(): void {
		if (this.#emergency.signal.aborted) return
		this.#shutdown ??= Promise.withResolvers<void>()
		this.#emergency.abort(this.#closedError)
		this.#stop.abort(this.#closedError)
		this.#machine.dispatch({ type: 'destroy' })
		// Cancellation must reach I/O even when destroy was called from a running effect.
		for (let session of this.#sessions.values()) session.destroy('pool_close')
	}

	[Symbol.dispose](): void {
		this.destroy()
	}
	async [Symbol.asyncDispose](): Promise<void> {
		await this.close()
	}

	#apply(commands: PoolCommand[]): void {
		for (let command of commands) {
			switch (command.type) {
				case 'opened': {
					let { maxSize, minSize, maxWaiters } = this.#machine.ctx
					dc('ydb:query.session.pool.opened').publish({
						driver: this.#driver.identity,
						maxSize,
						minSize,
						maxWaiters,
					})
					break
				}
				case 'create':
					this.#create(command.creation, command.request)
					break
				case 'cancel_create':
					this.#creates.get(command.creation)?.abort(command.reason)
					break
				case 'created': {
					let session = this.#sessions.get(command.session)
					if (session)
						dc('ydb:query.session.created').publish({
							driver: this.#driver.identity,
							sessionId: session.id,
							nodeId: session.nodeId,
						})
					break
				}
				case 'offer':
					// Preserve the cancellation window between selecting a session and issuing its lease.
					queueMicrotask(() =>
						this.#machine.dispatch({ type: 'accept', request: command.request })
					)
					break
				case 'deliver':
					this.#deliver(command.request, command.session)
					break
				case 'reject': {
					let request = this.#requests.get(command.request)
					if (!request) break
					this.#requests.delete(command.request)
					request.detach()
					request.reject(
						command.error === this.#full
							? new SessionPoolFullError(this.#machine.ctx.maxWaiters)
							: command.error
					)
					break
				}
				case 'queued':
				case 'dequeued':
					dc(
						`ydb:query.session.waiter.${command.type === 'queued' ? 'enqueued' : 'dequeued'}`
					).publish({ driver: this.#driver.identity })
					break
				case 'released':
					dc('ydb:query.session.released').publish({
						driver: this.#driver.identity,
						sessionId: command.serverId,
						nodeId: command.nodeId,
					})
					break
				case 'retire':
					this.#retire(command)
					break
				case 'forget':
					this.#forget(command.session)
					break
				case 'abort':
					this.#stop.abort(this.#closedError)
					break
				case 'closed':
					dc('ydb:query.session.pool.closed').publish({ driver: this.#driver.identity })
					this.#shutdown?.resolve()
					break
			}
		}
	}

	#create(creation: number, requestId: number | undefined): void {
		let context = this.#machine.ctx
		if (
			this.signal.aborted ||
			(this.closed &&
				(requestId === undefined ||
					context.rootOperations + context.continuingOperations === 0))
		) {
			this.#machine.dispatch({ type: 'create_failed', creation, error: this.#closedError })
			return
		}
		let request = requestId === undefined ? undefined : this.#requests.get(requestId)
		let controller = new AbortController()
		this.#creates.set(creation, controller)
		void (async () => {
			try {
				using linked = linkSignals(request?.signal, this.signal, controller.signal)
				let open = () =>
					sessionCreateCh.tracePromise(
						() => Session.open(this.#driver, linked.signal, this.signal),
						{ driver: this.#driver.identity }
					)
				let session = await (request?.enter ? request.enter(open) : open())
				session.signal.throwIfAborted()
				this.#creates.delete(creation)
				this.#sessions.set(creation, session)
				this.#identities.set(session, creation)
				let lost = () =>
					this.#machine.dispatch({
						type: 'lost',
						session: creation,
						reason: session.closeReason ?? 'stream_closed',
						error: session.signal.reason,
					})
				this.#listeners.set(creation, lost)
				session.signal.addEventListener('abort', lost, { once: true })
				this.#machine.dispatch({ type: 'created', creation })
			} catch (error) {
				this.#creates.delete(creation)
				this.#machine.dispatch({ type: 'create_failed', creation, error })
			}
		})()
	}

	#deliver(requestId: number, sessionId: number): void {
		let request = this.#requests.get(requestId)
		let session = this.#sessions.get(sessionId)
		let failure = this.signal.aborted
			? this.signal.reason
			: request?.signal?.aborted
				? request.signal.reason
				: !session?.alive
					? (session?.signal.reason ?? this.#closedError)
					: undefined
		if (!request || failure !== undefined) {
			this.#machine.dispatch({
				type: 'handoff_failed',
				request: requestId,
				session: sessionId,
				error: failure ?? this.#closedError,
			})
			return
		}
		this.#requests.delete(requestId)
		request.detach()
		let lease = new SessionLease(this, session!)
		dc('ydb:query.session.acquired').publish({
			driver: this.#driver.identity,
			sessionId: session!.id,
			nodeId: session!.nodeId,
		})
		try {
			this.signal.throwIfAborted()
			request.signal?.throwIfAborted()
			session!.signal.throwIfAborted()
			request.resolve(lease)
		} catch (error) {
			lease[Symbol.dispose]()
			request.reject(error)
		}
	}

	#forget(identity: number): void {
		let session = this.#sessions.get(identity)
		let listener = this.#listeners.get(identity)
		if (session && listener) session.signal.removeEventListener('abort', listener)
		this.#listeners.delete(identity)
		this.#sessions.delete(identity)
	}

	#retire(command: Extract<PoolCommand, { type: 'retire' }>): void {
		let session = this.#sessions.get(command.session)
		if (!session) {
			if (command.mode === 'close')
				this.#machine.dispatch({ type: 'session_closed', session: command.session })
			return
		}
		let listener = this.#listeners.get(command.session)
		if (listener) session.signal.removeEventListener('abort', listener)
		this.#listeners.delete(command.session)
		if (command.announce)
			dc('ydb:query.session.closed').publish({
				driver: this.#driver.identity,
				sessionId: session.id,
				nodeId: session.nodeId,
				reason: command.reason,
				uptime: Date.now() - session.createdAt,
			})
		if (command.mode === 'close' && !this.#emergency.signal.aborted) {
			void session
				.close(command.reason)
				.finally(() =>
					this.#machine.dispatch({ type: 'session_closed', session: command.session })
				)
				.catch(() => {})
		} else {
			if (command.mode !== 'forget') session.destroy(command.reason)
			this.#forget(command.session)
			if (command.mode === 'close')
				this.#machine.dispatch({ type: 'session_closed', session: command.session })
		}
	}
}
