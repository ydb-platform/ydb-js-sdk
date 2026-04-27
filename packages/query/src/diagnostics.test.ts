import { afterEach, expect, test } from 'vitest'
import { channel as dcChannel, tracingChannel } from 'node:diagnostics_channel'
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

/** Subscribe to a plain channel, collect published payloads. */
function collect(name: string) {
	let payloads: unknown[] = []
	let fn = (msg: unknown) => payloads.push(structuredClone(msg))
	dcChannel(name).subscribe(fn)
	return { payloads, stop: () => dcChannel(name).unsubscribe(fn) }
}

/** Subscribe to start events of a tracing channel, collect context snapshots. */
function collectStart(name: string) {
	let contexts: Record<string, unknown>[] = []
	let handlers = {
		start(ctx: Record<string, unknown>) {
			contexts.push({ ...ctx })
		},
	}
	tracingChannel(name).subscribe(handlers)
	return { contexts, stop: () => tracingChannel(name).unsubscribe(handlers) }
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

test('ydb:session.created — fires with sessionId and nodeId after pool.acquire()', async () => {
	srv = await startServer()
	pool = new SessionPool(srv.driver, { maxSize: 1 })

	let { payloads, stop } = collect('ydb:session.created')
	try {
		let lease = await pool.acquire()
		lease[Symbol.dispose]()

		expect(payloads).toHaveLength(1)
		expect(payloads[0]).toMatchObject({
			sessionId: expect.stringContaining('ses-'),
			nodeId: 1n,
		})
	} finally {
		stop()
	}
})

test('ydb:session.evicted — fires when the server kills the session attach stream', async () => {
	srv = await startServer()
	pool = new SessionPool(srv.driver, { maxSize: 1 })

	let lease = await pool.acquire()
	let sessionId = lease.id
	lease[Symbol.dispose]()

	let { payloads, stop } = collect('ydb:session.evicted')
	try {
		srv.breakSession(sessionId)
		// Give the attach-stream abort time to propagate.
		await new Promise((r) => setTimeout(r, 60))

		expect(payloads).toHaveLength(1)
		expect(payloads[0]).toMatchObject({ sessionId })
	} finally {
		stop()
	}
})

test('ydb:session.destroyed — fires for every open session on pool.close()', async () => {
	srv = await startServer()
	pool = new SessionPool(srv.driver, { maxSize: 2 })

	// Two sessions in the pool (idle after release).
	let a = await pool.acquire()
	let b = await pool.acquire()
	a[Symbol.dispose]()
	b[Symbol.dispose]()

	let { payloads, stop } = collect('ydb:session.destroyed')
	try {
		await pool.close()
		pool = undefined

		expect(payloads).toHaveLength(2)
		for (let p of payloads) {
			expect(p).toMatchObject({
				sessionId: expect.stringContaining('ses-'),
				nodeId: 1n,
			})
		}
	} finally {
		stop()
	}
})

test('tracing:ydb:session.create — start fires when pool grows a new session', async () => {
	srv = await startServer()
	pool = new SessionPool(srv.driver, { maxSize: 1 })

	let { contexts, stop } = collectStart('tracing:ydb:session.create')
	try {
		let lease = await pool.acquire()
		lease[Symbol.dispose]()

		// start fires before the session is available — at least one context captured.
		expect(contexts.length).toBeGreaterThanOrEqual(1)
	} finally {
		stop()
	}
})
