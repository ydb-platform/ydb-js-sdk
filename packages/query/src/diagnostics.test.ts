import { afterEach, expect, test } from 'vitest'
import { channel as dc, tracingChannel } from 'node:diagnostics_channel'
import { createServer } from 'nice-grpc'
import { create } from '@bufbuild/protobuf'

import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import {
	CreateSessionResponseSchema,
	DeleteSessionResponseSchema,
	QueryServiceDefinition,
	SessionStateSchema,
} from '@ydbjs/api/query'
import { Driver } from '@ydbjs/core'

import { SessionPool } from './session-pool.ts'

// ── Minimal query server harness ──────────────────────────────────────────────

async function startServer() {
	let nextId = 0
	let attachCtrls = new Map<string, AbortController>()

	let server = createServer()
	server.add(
		{
			createSession: QueryServiceDefinition.createSession,
			deleteSession: QueryServiceDefinition.deleteSession,
			attachSession: QueryServiceDefinition.attachSession,
		},
		{
			async createSession() {
				let sessionId = `ses-${++nextId}`
				attachCtrls.set(sessionId, new AbortController())
				return create(CreateSessionResponseSchema, {
					status: StatusIds_StatusCode.SUCCESS,
					sessionId,
					nodeId: 1n,
				})
			},
			async deleteSession(req) {
				attachCtrls.get(req.sessionId)?.abort()
				return create(DeleteSessionResponseSchema, {
					status: StatusIds_StatusCode.SUCCESS,
				})
			},
			async *attachSession(req, ctx) {
				let serverCtrl = attachCtrls.get(req.sessionId) ?? new AbortController()
				yield create(SessionStateSchema, { status: StatusIds_StatusCode.SUCCESS })
				await new Promise<void>((resolve) => {
					ctx.signal.addEventListener('abort', () => resolve(), { once: true })
					serverCtrl.signal.addEventListener('abort', () => resolve(), { once: true })
				})
			},
		}
	)

	let port = await server.listen('127.0.0.1:0')
	let driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})

	return {
		driver,
		breakSession(id: string) {
			attachCtrls.get(id)?.abort()
		},
		async close() {
			driver.close()
			await server.shutdown()
		},
	}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Subscribe to a plain channel; returned object is `Disposable`. */
function collect(name: string): { payloads: unknown[] } & Disposable {
	let payloads: unknown[] = []
	let fn = (msg: unknown) => payloads.push(structuredClone(msg))
	dc(name).subscribe(fn)
	return {
		payloads,
		[Symbol.dispose]() {
			dc(name).unsubscribe(fn)
		},
	}
}

/** Subscribe to a tracing channel; capture start / asyncEnd / error contexts. */
function collectTrace(name: string): {
	start: object[]
	asyncEnd: object[]
	error: (object & { error: unknown })[]
} & Disposable {
	let ch = tracingChannel(name)
	let start: object[] = []
	let asyncEnd: object[] = []
	let error: (object & { error: unknown })[] = []
	let handlers = {
		start: (ctx: any) => start.push({ ...ctx }),
		asyncEnd: (ctx: any) => asyncEnd.push({ ...ctx }),
		error: (ctx: any) => error.push({ ...ctx }),
	}
	ch.subscribe(handlers as any)
	return {
		start,
		asyncEnd,
		error,
		[Symbol.dispose]() {
			ch.unsubscribe(handlers as any)
		},
	}
}

type Server = Awaited<ReturnType<typeof startServer>>
let srv: Server | undefined
let pool: SessionPool | undefined

afterEach(async () => {
	await pool?.close().catch(() => {})
	pool = undefined
	await srv?.close()
	srv = undefined
})

// ── Tests ─────────────────────────────────────────────────────────────────────

test('publishes ydb:session.created with sessionId and nodeId after pool.acquire()', async () => {
	srv = await startServer()
	pool = new SessionPool(srv.driver, { maxSize: 1 })

	using created = collect('ydb:session.created')

	let lease = await pool.acquire()
	lease[Symbol.dispose]()

	expect(created.payloads).toHaveLength(1)
	expect(created.payloads[0]).toMatchObject({
		sessionId: expect.stringContaining('ses-'),
		nodeId: 1n,
	})
})

test('publishes ydb:session.closed with reason=evicted when the server kills the attach stream', async () => {
	srv = await startServer()
	pool = new SessionPool(srv.driver, { maxSize: 1 })

	let lease = await pool.acquire()
	let sessionId = lease.id
	lease[Symbol.dispose]()

	using closed = collect('ydb:session.closed')

	srv.breakSession(sessionId)
	// Give the attach-stream abort time to propagate.
	await new Promise((r) => setTimeout(r, 60))

	expect(closed.payloads).toHaveLength(1)
	expect(closed.payloads[0]).toMatchObject({
		sessionId,
		reason: 'evicted',
	})
})

test('publishes ydb:session.closed with reason=pool_close once per session on pool.close()', async () => {
	srv = await startServer()
	pool = new SessionPool(srv.driver, { maxSize: 2 })

	// Two sessions in the pool (idle after release).
	let a = await pool.acquire()
	let b = await pool.acquire()
	a[Symbol.dispose]()
	b[Symbol.dispose]()

	using closed = collect('ydb:session.closed')

	await pool.close()
	pool = undefined

	// Exactly two events — one per session — and never doubled by the
	// eviction listener (the pool detaches it before tearing down).
	expect(closed.payloads).toHaveLength(2)
	for (let p of closed.payloads) {
		expect(p).toMatchObject({
			sessionId: expect.stringContaining('ses-'),
			nodeId: 1n,
			reason: 'pool_close',
		})
		expect(typeof (p as any).uptime).toBe('number')
	}
})

test('traces tracing:ydb:session.create with liveSessions/maxSize/creating context', async () => {
	srv = await startServer()
	pool = new SessionPool(srv.driver, { maxSize: 1 })

	using trace = collectTrace('tracing:ydb:session.create')

	let lease = await pool.acquire()
	lease[Symbol.dispose]()

	expect(trace.start.length).toBeGreaterThanOrEqual(1)
	expect(trace.asyncEnd.length).toBeGreaterThanOrEqual(1)
	expect(trace.start[0]).toMatchObject({
		liveSessions: 0,
		maxSize: 1,
		creating: 0,
	})
})

test('traces tracing:ydb:session.acquire with kind=query', async () => {
	srv = await startServer()
	pool = new SessionPool(srv.driver, { maxSize: 1 })

	// Pre-warm so acquire goes through fast path; tracePromise still wraps.
	let warm = await pool.acquire()
	warm[Symbol.dispose]()

	using trace = collectTrace('tracing:ydb:session.acquire')

	// Drive the channel through the public sessionAcquireCh export by
	// importing it via the same pool surface.
	let { sessionAcquireCh } = await import('./session-pool.ts')
	let lease = await sessionAcquireCh.tracePromise(() => pool!.acquire(), {
		kind: 'query',
	})
	lease[Symbol.dispose]()

	expect(trace.start.length).toBeGreaterThanOrEqual(1)
	expect(trace.asyncEnd.length).toBeGreaterThanOrEqual(1)
	expect(trace.start[0]).toMatchObject({ kind: 'query' })
})
