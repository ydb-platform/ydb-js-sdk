import { expect, test } from 'vitest'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { tracingChannel } from 'node:diagnostics_channel'
import { create } from '@bufbuild/protobuf'
import { abortable, linkSignals } from '@ydbjs/abortable'

import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import {
	BeginTransactionResponseSchema,
	CommitTransactionResponseSchema,
	CreateSessionResponseSchema,
	DeleteSessionResponseSchema,
	ExecuteQueryResponsePartSchema,
	QueryServiceDefinition,
	RollbackTransactionResponseSchema,
	SessionStateSchema,
} from '@ydbjs/api/query'
import { Driver } from '@ydbjs/core'
import { YDBError } from '@ydbjs/error'
import { Server } from '@ydbjs/grpc'

import { Session } from './session.ts'
import { SessionLease, SessionPool, SessionPoolClosedError } from './session-pool.ts'
import { type TX, query } from './index.ts'

// This file is deliberately narrow: only scenarios that need server-side
// fault injection (killing a session's attach stream mid-flight, holding
// CreateSession open to race pool.close(), forcing a bad first attach
// message) — none of that is triggerable on demand against a real YDB
// instance. Golden-path SessionPool/Session/SessionLease behavior (LIFO
// reuse, warm-up, claim lifecycle, wait-queue capacity) lives in
// ../tests/session-pool.test.ts against real YDB instead.

/**
 * Controlled loopback QueryService. Tests get:
 *  - `breakSession(id)`: server-side abort of a session's attach stream
 *    (simulates YDB-driven invalidation).
 *  - `holdCreateSession()`: blocks every subsequent `CreateSession` until
 *    the returned release function is called (for races with pool close).
 *  - `firstAttachStatus`: let tests make attach fail on the first message.
 */
async function startQueryServer() {
	let nextId = 0
	let attachCtrls = new Map<string, AbortController>()
	let holdPromise: Promise<void> | undefined
	let holdResolve: (() => void) | undefined
	let firstAttachStatus = StatusIds_StatusCode.SUCCESS

	let createCount = 0
	let deleteCalls: string[] = []
	let attachCalls: string[] = []

	let server = new Server()
	server.add(QueryServiceDefinition, {
		async createSession() {
			createCount++
			if (holdPromise) await holdPromise
			let sessionId = `svr-${++nextId}`
			attachCtrls.set(sessionId, new AbortController())
			return create(CreateSessionResponseSchema, {
				status: StatusIds_StatusCode.SUCCESS,
				sessionId,
				nodeId: 0n,
			})
		},
		async deleteSession(req) {
			deleteCalls.push(req.sessionId)
			attachCtrls.get(req.sessionId)?.abort()
			return create(DeleteSessionResponseSchema, {
				status: StatusIds_StatusCode.SUCCESS,
			})
		},
		async *attachSession(req, ctx) {
			attachCalls.push(req.sessionId)
			let serverCtrl = attachCtrls.get(req.sessionId) ?? new AbortController()

			yield create(SessionStateSchema, { status: firstAttachStatus })
			if (firstAttachStatus !== StatusIds_StatusCode.SUCCESS) return

			await new Promise<void>((resolve) => {
				if (ctx.signal.aborted || serverCtrl.signal.aborted) return resolve()
				let onAbort = () => resolve()
				ctx.signal.addEventListener('abort', onAbort, { once: true })
				serverCtrl.signal.addEventListener('abort', onAbort, { once: true })
			})
		},
	})

	let port = await server.listen('127.0.0.1:0')
	let driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})

	return {
		server,
		driver,
		get createCount() {
			return createCount
		},
		get deleteCalls() {
			return deleteCalls
		},
		get attachCalls() {
			return attachCalls
		},
		breakSession(id: string) {
			attachCtrls.get(id)?.abort()
		},
		setFirstAttachStatus(status: number) {
			firstAttachStatus = status
		},
		holdCreateSession() {
			holdPromise = new Promise<void>((r) => (holdResolve = r))
			return () => holdResolve?.()
		},
		[Symbol.dispose]() {
			holdResolve?.()
			driver.close()
			server[Symbol.dispose]()
		},
	}
}

/** Poll a condition until true or timeout — async server effects need time. */
async function until(cond: () => boolean, timeoutMs = 500): Promise<void> {
	let deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (cond()) return
		// oxlint-disable-next-line no-await-in-loop
		await new Promise((r) => setTimeout(r, 5))
	}
	throw new Error(`timed out waiting for condition (${timeoutMs}ms)`)
}

test('eviction of a busy session pumps a fresh one to the oldest waiter', async () => {
	using srv = await startQueryServer()
	await using pool = new SessionPool(srv.driver, { maxSize: 1 })

	let held = await pool.acquire()
	let heldId = held.id
	let waiter = pool.acquire()

	// Server kills the in-use session's attach stream — monitor catches it,
	// pool evicts, pumps a fresh create for the waiter.
	srv.breakSession(heldId)

	let replacement = await waiter
	expect(replacement.id).not.toBe(heldId)
	expect(srv.createCount).toBe(2)

	held[Symbol.dispose]() // no-op: session already broken
	replacement[Symbol.dispose]()
})

test('close() during in-flight create does not hang and rejects the pending acquire', async () => {
	using srv = await startQueryServer()
	let release = srv.holdCreateSession()
	await using pool = new SessionPool(srv.driver, { maxSize: 1 })

	// Pre-catch: close() will cancel the in-flight RPC via abort, and we
	// don't want the racing rejection to surface as unhandled.
	let acquiring = pool.acquire().then(
		(lease) => ({ ok: true as const, lease }),
		(error) => ({ ok: false as const, error })
	)

	// Let the RPC actually reach the server before we pull the rug.
	await new Promise((r) => setTimeout(r, 30))

	let closing = pool.close()
	release() // let the stuck server-side handler unwind regardless

	await closing // must not hang
	let result = await acquiring
	expect(result.ok).toBe(false)
})

test('lease.signal is lease-scoped — ghost subscribers do not accumulate', async () => {
	using srv = await startQueryServer()
	await using pool = new SessionPool(srv.driver, { maxSize: 1 })

	let lease = await pool.acquire()
	let capturedSignal = lease.signal
	let id = lease.id
	lease[Symbol.dispose]()

	// Break the session AFTER the lease is disposed. A naive implementation
	// that exposes session.signal directly would abort this signal too —
	// that's how 1000 concurrent queries on a hot session would leave
	// 1000 ghost subscribers behind.
	srv.breakSession(id)
	await new Promise((r) => setTimeout(r, 50))

	expect(capturedSignal.aborted).toBe(false)
})

test('Session.open deletes the server-side session when attach first message is bad', async () => {
	using srv = await startQueryServer()
	srv.setFirstAttachStatus(StatusIds_StatusCode.BAD_SESSION)

	await expect(Session.open(srv.driver)).rejects.toBeInstanceOf(YDBError)

	// Fire-and-forget DeleteSession — wait for the RPC to actually land.
	await until(() => srv.deleteCalls.length > 0)
	expect(srv.deleteCalls).toHaveLength(1)
})

test('Session.open aborts the attach stream when the caller signal fires mid-wait', async () => {
	using srv = await startQueryServer()

	// Hold the first attach message forever — the harness normally yields
	// SUCCESS on first message; here we want to verify cancellation during
	// the wait, so swap the first status into a different keepalive.
	// Easiest approach: don't emit first message — achieved by making the
	// attach handler hang before yielding. Patch via the harness:
	srv.setFirstAttachStatus(StatusIds_StatusCode.SUCCESS)

	let ctrl = new AbortController()
	let opening = Session.open(srv.driver, ctrl.signal)

	// Wait for the attach RPC to reach the server.
	await until(() => srv.attachCalls.length > 0)

	// Client cancellation closes the attach stream; the forward
	// listener in #bindAttach propagates the abort into #attach.
	ctrl.abort(new Error('caller gave up'))

	// The promise rejects. Session.open may resolve OK if attach's first
	// SUCCESS message was already received before we aborted — in that
	// race we simply verify that either resolution cleans up.
	await opening.then(
		(session) => session.close('pool_close'),
		() => {}
	)
	expect(srv.attachCalls).toHaveLength(1)
})

test('refills to minSize after a session is evicted by the server', async () => {
	using srv = await startQueryServer()
	await using pool = new SessionPool(srv.driver, { maxSize: 5, minSize: 2 })

	await until(() => pool.stats.total === 2, 1000)
	let createsBeforeEviction = srv.createCount
	expect(srv.attachCalls).toHaveLength(2)
	let killed = srv.attachCalls[0]!

	// Server tears down the attach stream → Session.#runMonitor flips it
	// broken → pool eviction listener removes from #all → refill kicks in.
	srv.breakSession(killed)

	await until(() => srv.createCount > createsBeforeEviction, 2000)
	await until(() => pool.stats.total === 2, 2000)

	expect(pool.stats.total).toBe(2)
	expect(srv.createCount).toBe(createsBeforeEviction + 1)
})

test('hands a warming session to a waiter when warm-up holds all capacity', async () => {
	using srv = await startQueryServer()
	let release = srv.holdCreateSession()

	await using pool = new SessionPool(srv.driver, { maxSize: 2, minSize: 2 })

	// Both create slots are taken by held warm-ups; acquire() must queue
	// rather than spawn a third create.
	let acquired = pool.acquire()
	await until(() => pool.stats.waiting === 1, 500)

	release()

	let lease = await acquired
	expect(lease).toBeInstanceOf(SessionLease)
	expect(pool.stats.waiting).toBe(0)
	// Two creates total — the waiter received a warm-up session via
	// #growAndPark's handoff path, no extra grow was issued.
	expect(srv.createCount).toBe(2)
})

test('pool.close() during warm-up settles without hanging', async () => {
	using srv = await startQueryServer()
	srv.holdCreateSession() // hold indefinitely; never released

	await using pool = new SessionPool(srv.driver, { maxSize: 5, minSize: 5 })

	// All five warm-up creates are blocked on the server. close() must
	// abort them through the linked close signal and resolve quickly.
	await Promise.race([
		pool.close(),
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error('pool.close() hung during warm-up')), 2000)
		),
	])

	expect(pool.closed).toBe(true)
})

test('close drains active and queued queries and leaves the shared driver usable', async (tc) => {
	using srv = await startQueryServer()
	let entered = Promise.withResolvers<void>()
	let finish = Promise.withResolvers<void>()
	let executions = 0
	srv.server.add(QueryServiceDefinition, {
		async *executeQuery(_request, context) {
			executions++
			entered.resolve()
			await abortable(context.signal, finish.promise)
			yield create(ExecuteQueryResponsePartSchema, { status: StatusIds_StatusCode.SUCCESS })
		},
	})
	using sql = query(srv.driver, { poolOptions: { maxSize: 1 } })
	let first = sql`SELECT 1`.signal(tc.signal).then((result) => result)
	await entered.promise
	let second = sql`SELECT 2`.signal(tc.signal).then((result) => result)
	let closed = false
	let closing = sql.close().then(() => {
		closed = true
		return undefined
	})
	let rejected = sql`SELECT 3`.signal(tc.signal).then((result) => result)

	await expect(rejected).rejects.toBeInstanceOf(SessionPoolClosedError)
	expect(closed).toBe(false)
	expect(srv.deleteCalls).toEqual([])
	finish.resolve()
	await first
	await second
	await closing

	expect(executions).toBe(2)
	expect(srv.deleteCalls).toHaveLength(1)
	await using other = query(srv.driver)
	await other`SELECT 4`.signal(tc.signal)
	expect(executions).toBe(3)
})

test('destroy cancels active and queued queries without deleting sessions or emitting callbacks', async (tc) => {
	using srv = await startQueryServer()
	let entered = Promise.withResolvers<void>()
	let finish = Promise.withResolvers<void>()
	let cancelled = Promise.withResolvers<void>()
	srv.server.add(QueryServiceDefinition, {
		async *executeQuery(_request, context) {
			entered.resolve()
			context.signal.addEventListener('abort', () => cancelled.resolve(), { once: true })
			await abortable(context.signal, finish.promise)
			yield create(ExecuteQueryResponsePartSchema, { status: StatusIds_StatusCode.SUCCESS })
		},
	})
	using sql = query(srv.driver, { poolOptions: { maxSize: 1 } })
	let callbacks: string[] = []
	let statement = sql`SELECT ${'retained-parameter'}`.signal(tc.signal)
	statement.on('done', () => callbacks.push('done'))
	statement.on('error', () => callbacks.push('error'))
	let first = statement.then(
		() => undefined,
		(error) => error
	)
	await entered.promise
	let second = sql`SELECT 2`.signal(tc.signal).then(
		() => undefined,
		(error) => error
	)
	let closing = sql.close()
	sql.destroy()

	expect(statement.active).toBe(false)
	expect(statement.parameters).toEqual({})
	expect(statement.eventNames()).toEqual([])
	let results = await Promise.all([first, second])
	for (let result of results) expect(result).toBeInstanceOf(Error)
	await cancelled.promise
	await closing
	expect(callbacks).toEqual([])
	expect(srv.deleteCalls).toEqual([])

	finish.resolve()
	await using other = query(srv.driver)
	await other`SELECT 3`.signal(tc.signal)
})

test('close lets an accepted transaction finish its body, nested queries and commit', async (tc) => {
	using srv = await startQueryServer()
	let entered = Promise.withResolvers<void>()
	let finish = Promise.withResolvers<void>()
	let calls: string[] = []
	srv.server.add(QueryServiceDefinition, {
		beginTransaction() {
			return create(BeginTransactionResponseSchema, {
				status: StatusIds_StatusCode.SUCCESS,
				txMeta: { id: 'transaction-1' },
			})
		},
		async *executeQuery() {
			calls.push('query')
			yield create(ExecuteQueryResponsePartSchema, { status: StatusIds_StatusCode.SUCCESS })
		},
		commitTransaction() {
			calls.push('commit')
			return create(CommitTransactionResponseSchema, { status: StatusIds_StatusCode.SUCCESS })
		},
	})
	using sql = query(srv.driver)
	let transaction = sql.begin({ signal: tc.signal }, async (tx, signal) => {
		await tx`SELECT 1`
		entered.resolve()
		await abortable(signal, finish.promise)
		await tx`SELECT 2`
		return 'completed'
	})
	await entered.promise
	let closing = sql.close()
	let rejected = sql.begin({ signal: tc.signal }, async () => 'unexpected')
	await expect(rejected).rejects.toBeInstanceOf(SessionPoolClosedError)
	expect(calls).toEqual(['query'])
	finish.resolve()
	expect(await transaction).toBe('completed')
	await closing
	expect(calls).toEqual(['query', 'query', 'commit'])
	expect(srv.deleteCalls).toHaveLength(1)
})

test('destroy aborts a transaction without starting rollback or session deletion', async (tc) => {
	using srv = await startQueryServer()
	let entered = Promise.withResolvers<void>()
	let finish = Promise.withResolvers<void>()
	let rollbacks = 0
	srv.server.add(QueryServiceDefinition, {
		beginTransaction() {
			return create(BeginTransactionResponseSchema, {
				status: StatusIds_StatusCode.SUCCESS,
				txMeta: { id: 'transaction-1' },
			})
		},
		rollbackTransaction() {
			rollbacks++
			return create(RollbackTransactionResponseSchema, {
				status: StatusIds_StatusCode.SUCCESS,
			})
		},
	})
	using sql = query(srv.driver)
	let transaction = sql.begin({ signal: tc.signal }, async (_tx, signal) => {
		entered.resolve()
		await abortable(signal, finish.promise)
	})
	let failure = transaction.catch((error: unknown) => error)
	await entered.promise
	sql.destroy()
	expect(await failure).toBeInstanceOf(Error)
	await sql.close()
	expect(rollbacks).toBe(0)
	expect(srv.deleteCalls).toEqual([])
})

test('ordinary transaction cancellation still rolls back and close waits for cleanup', async (tc) => {
	using srv = await startQueryServer()
	let entered = Promise.withResolvers<void>()
	let finish = Promise.withResolvers<void>()
	let rollbackEntered = Promise.withResolvers<void>()
	let finishRollback = Promise.withResolvers<void>()
	let closeHookEntered = Promise.withResolvers<void>()
	let finishCloseHook = Promise.withResolvers<void>()
	let rollbackSignal: AbortSignal | undefined
	let closedTransactions: boolean[] = []
	srv.server.add(QueryServiceDefinition, {
		beginTransaction() {
			return create(BeginTransactionResponseSchema, {
				status: StatusIds_StatusCode.SUCCESS,
				txMeta: { id: 'transaction-1' },
			})
		},
		async rollbackTransaction(_request, context) {
			rollbackSignal = context.signal
			rollbackEntered.resolve()
			await abortable(context.signal, finishRollback.promise)
			return create(RollbackTransactionResponseSchema, {
				status: StatusIds_StatusCode.SUCCESS,
			})
		},
	})
	using sql = query(srv.driver)
	let cancellation = new AbortController()
	using caller = linkSignals(cancellation.signal, tc.signal)
	let transaction = sql.begin({ signal: caller.signal }, async (tx, signal) => {
		tx.onClose(async (committed) => {
			closedTransactions.push(committed)
			closeHookEntered.resolve()
			await finishCloseHook.promise
		})
		entered.resolve()
		await abortable(signal, finish.promise)
	})
	let failure = transaction.catch((error: unknown) => error)
	await entered.promise
	cancellation.abort(new Error('caller cancelled'))
	await rollbackEntered.promise
	expect(await failure).toBeInstanceOf(Error)
	let closed = false
	let closing = sql.close().then(() => {
		closed = true
		return undefined
	})
	let observer = srv.driver.createClient(QueryServiceDefinition)
	await observer.beginTransaction({ sessionId: 'barrier' }, { signal: tc.signal })
	expect(rollbackSignal?.aborted).toBe(false)
	expect(closedTransactions).toEqual([])
	expect(closed).toBe(false)
	expect(srv.deleteCalls).toEqual([])
	finishRollback.resolve()
	await closeHookEntered.promise
	await observer.beginTransaction({ sessionId: 'barrier' }, { signal: tc.signal })
	expect(closed).toBe(false)
	expect(srv.deleteCalls).toEqual([])
	finishCloseHook.resolve()
	await closing
	expect(closedTransactions).toEqual([false])
	expect(srv.deleteCalls).toHaveLength(1)
})

test('failed driver readiness releases the query operation and allows close to finish', async (tc) => {
	using srv = await startQueryServer()
	using sql = query(srv.driver)
	srv.driver.close()
	let statement = sql`SELECT 1`.signal(tc.signal)
	statement.on('error', () => {})
	let failure = statement.then(
		() => undefined,
		(error) => error
	)

	expect(await failure).toBeInstanceOf(Error)
	expect(statement.active).toBe(false)
	await sql.close()
	expect(srv.createCount).toBe(0)
})

test('disposing one query clears its retained state without destroying the client', async (tc) => {
	using srv = await startQueryServer()
	let entered = Promise.withResolvers<void>()
	let finish = Promise.withResolvers<void>()
	srv.server.add(QueryServiceDefinition, {
		async *executeQuery(_request, context) {
			entered.resolve()
			await abortable(context.signal, finish.promise)
			yield create(ExecuteQueryResponsePartSchema, { status: StatusIds_StatusCode.SUCCESS })
		},
	})
	await using sql = query(srv.driver)
	let statement = sql`SELECT ${'retained-parameter'}`.signal(tc.signal)
	let callbacks: string[] = []
	statement.on('done', () => callbacks.push('done'))
	statement.on('error', () => callbacks.push('error'))
	let failure = statement.then(
		() => undefined,
		(error) => error
	)
	await entered.promise
	await statement.dispose()

	expect(statement.parameters).toEqual({})
	expect(statement.eventNames()).toEqual([])
	expect(statement.active).toBe(false)
	expect(await failure).toBeDefined()
	expect(callbacks).toEqual([])
	let reused = statement.then(
		() => undefined,
		(error) => error
	)
	expect(await reused).toMatchObject({ message: 'Query has been disposed.' })
	finish.resolve()
	await sql`SELECT 2`.signal(tc.signal)
})

test('invalid query setup does not leave an operation blocking close', async (tc) => {
	let nativeError: unknown
	try {
		AbortSignal.timeout(-1)
	} catch (error) {
		nativeError = error
	}
	if (!(nativeError instanceof Error)) throw new Error('Runtime accepted a negative timeout')

	using srv = await startQueryServer()
	using sql = query(srv.driver)
	let statement = sql`SELECT 1`.timeout(-1).signal(tc.signal)
	let failure = statement.then(
		() => undefined,
		(error) => error
	)

	let error = await failure
	expect(error).toBeInstanceOf(nativeError.constructor)
	expect(error).toMatchObject({ message: nativeError.message })
	expect(statement.active).toBe(false)
	await sql.close()
	expect(srv.createCount).toBe(0)
})

test('destroying a query started with execute does not leave an unhandled rejection', async (tc) => {
	using srv = await startQueryServer()
	using sql = query(srv.driver)
	let statement = sql`SELECT 1`.signal(tc.signal)
	statement.execute()
	let failure = statement.then(
		() => undefined,
		(error) => error
	)
	sql.destroy()

	expect(await failure).toBeInstanceOf(SessionPoolClosedError)
	await nextTurn()
})

test('destroy rejects an acquisition before a dequeued session becomes a lease', async (tc) => {
	using srv = await startQueryServer()
	using pool = new SessionPool(srv.driver)
	let warm = await pool.acquire(tc.signal)
	warm[Symbol.dispose]()
	let pending = pool.acquire(tc.signal)
	pool.destroy()

	await expect(pending).rejects.toBeInstanceOf(SessionPoolClosedError)
	expect(pool.stats.total).toBe(0)
	expect(pool.stats.idle).toBe(0)
})

test('reentrant close shares one shutdown operation', async () => {
	using srv = await startQueryServer()
	using pool = new SessionPool(srv.driver)
	let nested: Promise<void> | undefined
	pool.signal.addEventListener(
		'abort',
		() => {
			nested = pool.close()
		},
		{ once: true }
	)
	let closing = pool.close()
	await closing

	expect(nested).toBe(closing)
})

test('destroy stops waiting for a transaction body that ignores cancellation', async (tc) => {
	using srv = await startQueryServer()
	let entered = Promise.withResolvers<void>()
	let body = Promise.withResolvers<void>()
	let callbacks: string[] = []
	srv.server.add(QueryServiceDefinition, {
		beginTransaction() {
			return create(BeginTransactionResponseSchema, {
				status: StatusIds_StatusCode.SUCCESS,
				txMeta: { id: 'transaction-1' },
			})
		},
	})
	using sql = query(srv.driver)
	let transaction = sql.begin({ signal: tc.signal }, async (tx) => {
		tx.onCommit(() => {
			callbacks.push('commit')
		})
		tx.onRollback(() => {
			callbacks.push('rollback')
		})
		tx.onClose(() => {
			callbacks.push('close')
		})
		entered.resolve()
		await body.promise
	})
	let failure = transaction.catch((error: unknown) => error)
	await entered.promise
	sql.destroy()

	expect(await failure).toBeInstanceOf(Error)
	await sql.close()
	body.reject(new Error('late body rejection'))
	await nextTurn()
	expect(callbacks).toEqual([])
	expect(srv.deleteCalls).toEqual([])
})

test('destroy cancels a pending attach without starting session deletion', async (tc) => {
	using server = new Server()
	let attached = Promise.withResolvers<void>()
	let never = Promise.withResolvers<void>()
	let deleteCalls = 0
	server.add(QueryServiceDefinition, {
		createSession() {
			return create(CreateSessionResponseSchema, {
				status: StatusIds_StatusCode.SUCCESS,
				sessionId: 'held-attach',
			})
		},
		async *attachSession(_request, context) {
			attached.resolve()
			await abortable(context.signal, never.promise)
			yield create(SessionStateSchema, { status: StatusIds_StatusCode.SUCCESS })
		},
		deleteSession() {
			deleteCalls++
			return create(DeleteSessionResponseSchema, { status: StatusIds_StatusCode.SUCCESS })
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using sql = query(driver)
	let statement = sql`SELECT 1`.signal(tc.signal)
	let failure = statement.then(
		() => undefined,
		(error) => error
	)
	await attached.promise
	sql.destroy()

	expect(await failure).toBeInstanceOf(Error)
	await sql.close()
	await nextTurn()
	expect(deleteCalls).toBe(0)
})

test('destroy aborts session deletion already started by close', async (tc) => {
	using server = new Server()
	let deleting = Promise.withResolvers<void>()
	let cancelled = Promise.withResolvers<void>()
	let never = Promise.withResolvers<void>()
	server.add(QueryServiceDefinition, {
		createSession() {
			return create(CreateSessionResponseSchema, {
				status: StatusIds_StatusCode.SUCCESS,
				sessionId: 'held-delete',
			})
		},
		async *attachSession(_request, context) {
			yield create(SessionStateSchema, { status: StatusIds_StatusCode.SUCCESS })
			await abortable(context.signal, never.promise)
		},
		async *executeQuery() {
			yield create(ExecuteQueryResponsePartSchema, { status: StatusIds_StatusCode.SUCCESS })
		},
		async deleteSession(_request, context) {
			context.signal.addEventListener('abort', () => cancelled.resolve(), { once: true })
			deleting.resolve()
			await abortable(context.signal, never.promise)
			return create(DeleteSessionResponseSchema, { status: StatusIds_StatusCode.SUCCESS })
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using sql = query(driver)
	await sql`SELECT 1`.signal(tc.signal)
	let closing = sql.close()
	await deleting.promise
	sql.destroy()

	await expect(closing).resolves.toBeUndefined()
	await cancelled.promise
})

test('close drains a query accepted before driver readiness and preserves its result', async (tc) => {
	using srv = await startQueryServer()
	srv.server.add(QueryServiceDefinition, {
		async *executeQuery() {
			yield create(ExecuteQueryResponsePartSchema, { status: StatusIds_StatusCode.SUCCESS })
		},
	})
	using sql = query(srv.driver)
	let statement = sql`SELECT 1`.signal(tc.signal).execute()
	await sql.close()
	let result = await statement

	expect(result).toEqual([])
	expect(srv.deleteCalls).toHaveLength(1)
})

test('close permits retries of a query already in progress', async (tc) => {
	using srv = await startQueryServer()
	let firstEntered = Promise.withResolvers<void>()
	let failFirst = Promise.withResolvers<void>()
	let secondEntered = Promise.withResolvers<void>()
	let finishSecond = Promise.withResolvers<void>()
	let attempts = 0
	srv.server.add(QueryServiceDefinition, {
		async *executeQuery(_request, context) {
			attempts++
			if (attempts === 1) {
				firstEntered.resolve()
				await abortable(context.signal, failFirst.promise)
				yield create(ExecuteQueryResponsePartSchema, {
					status: StatusIds_StatusCode.UNAVAILABLE,
				})
				return
			}
			secondEntered.resolve()
			await abortable(context.signal, finishSecond.promise)
			yield create(ExecuteQueryResponsePartSchema, { status: StatusIds_StatusCode.SUCCESS })
		},
	})
	using sql = query(srv.driver)
	let statement = sql`SELECT 1`.idempotent().signal(tc.signal)
	let result = statement.then(
		(rows) => rows,
		(error: unknown) => error
	)
	await abortable(tc.signal, firstEntered.promise)
	let closed = false
	let closing = sql.close().then(() => {
		closed = true
		return undefined
	})
	failFirst.resolve()
	await abortable(tc.signal, secondEntered.promise)

	expect(attempts).toBe(2)
	expect(closed).toBe(false)
	expect(srv.deleteCalls).toEqual([])
	finishSecond.resolve()
	expect(await result).toEqual([])
	await closing

	expect(closed).toBe(true)
	expect(attempts).toBe(2)
	expect(srv.deleteCalls).toHaveLength(1)
})

test('releases transaction hook captures even when a close hook throws', async (tc) => {
	using srv = await startQueryServer()
	let failure = new Error('close hook failed')
	let references: WeakRef<() => void>[] = []
	let transactionClient: TX | undefined
	srv.server.add(QueryServiceDefinition, {
		beginTransaction() {
			return create(BeginTransactionResponseSchema, {
				status: StatusIds_StatusCode.SUCCESS,
				txMeta: { id: 'transaction-1' },
			})
		},
		commitTransaction() {
			return create(CommitTransactionResponseSchema, { status: StatusIds_StatusCode.SUCCESS })
		},
	})
	using sql = query(srv.driver)
	let transaction = sql.begin({ signal: tc.signal }, async (tx) => {
		transactionClient = tx
		let onCommit = () => {}
		let onRollback = () => {}
		let onClose = () => {
			throw failure
		}
		tx.onCommit(onCommit)
		tx.onRollback(onRollback)
		tx.onClose(onClose)
		references.push(new WeakRef(onCommit), new WeakRef(onRollback), new WeakRef(onClose))
	})
	await expect(transaction).rejects.toBe(failure)

	// Keep the client alive without dereferencing targets in the GC jobs.
	for (let iteration = 0; iteration < 5; iteration++) {
		// oxlint-disable-next-line no-await-in-loop
		await nextTurn()
		globalThis.gc!()
	}
	let retained = references.map((reference) => reference.deref())
	expect(retained).toEqual([undefined, undefined, undefined])
	expect(() => transactionClient!.onCommit(() => {})).toThrow(/aborted/i)
})

test('destroy after the begin response prevents the transaction body from starting', async (tc) => {
	using srv = await startQueryServer()
	srv.server.add(QueryServiceDefinition, {
		beginTransaction() {
			return create(BeginTransactionResponseSchema, {
				status: StatusIds_StatusCode.SUCCESS,
				txMeta: { id: 'transaction-1' },
			})
		},
	})
	using sql = query(srv.driver)
	let trace = tracingChannel('tracing:ydb:query.begin')
	let destroy = () => sql.destroy()
	trace.asyncEnd.subscribe(destroy)
	tc.onTestFinished(() => {
		trace.asyncEnd.unsubscribe(destroy)
	})
	let bodyCalls = 0
	let transaction = sql.begin({ signal: tc.signal }, async () => {
		bodyCalls++
	})
	let failure = transaction.catch((error: unknown) => error)

	expect(await failure).toBeInstanceOf(Error)
	expect(bodyCalls).toBe(0)
	expect(srv.deleteCalls).toEqual([])
})

for (let destroyFrom of ['stats', 'done'] as const) {
	test(`destroy from ${destroyFrom} prevents subsequent query events and results`, async (tc) => {
		using srv = await startQueryServer()
		srv.server.add(QueryServiceDefinition, {
			async *executeQuery() {
				yield create(ExecuteQueryResponsePartSchema, {
					status: StatusIds_StatusCode.SUCCESS,
					execStats: {},
				})
			},
		})
		using sql = query(srv.driver)
		let events: string[] = []
		let statement = sql`SELECT 1`.signal(tc.signal)
		statement.on('stats', () => {
			events.push('stats')
			if (destroyFrom === 'stats') sql.destroy()
		})
		statement.on('done', () => {
			events.push('done')
			if (destroyFrom === 'done') sql.destroy()
		})
		statement.on('error', () => {
			events.push('error')
		})
		let failure = statement.then(
			() => undefined,
			(error) => error
		)

		expect(await failure).toBeInstanceOf(Error)
		expect(events).toEqual(destroyFrom === 'stats' ? ['stats'] : ['stats', 'done'])
		expect(statement.eventNames()).toEqual([])
	})
}
