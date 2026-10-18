import { AsyncLocalStorage } from 'node:async_hooks'

import {
	type CallOptions,
	type MethodDefinition,
	RpcError,
	type RpcStatus,
	Status,
} from '@ydbjs/grpc'
import { expect, test, vi } from 'vitest'

import type { Connection } from './conn.js'
import type { EndpointPool } from './endpoints/endpoints-runtime.js'
import type { EndpointRef, RoutingSnapshot } from './endpoints/snapshot.js'
import { createRoutingTransport } from './routing.js'

let method: MethodDefinition<Record<string, never>, never> = {
	path: '/S/M',
	requestStream: false,
	responseStream: true,
	requestSerialize: () => new Uint8Array(),
	responseDeserialize: () => {
		throw new Error('No payload in routing tests')
	},
}

// A controllable endpoint fixes terminal-status races independently of network timing.
function fixture(state: EndpointRef['state'] = 'active') {
	let started: bigint[] = []
	let ended: bigint[] = []
	let reports: Array<{ nodeId: bigint; ok: boolean }> = []
	let selections: Array<{ nodeId?: bigint; hard: boolean }> = []
	let entered = Promise.withResolvers<CallOptions>()
	let terminal = Promise.withResolvers<RpcStatus>()
	let ref = { nodeId: 7n, address: 'h:1', location: 'A', state } as EndpointRef
	let connection: Connection = {
		endpoint: { nodeId: 7n, address: 'h:1', location: 'A', pile: '' },
		client: {
			state: 'ready',
			async connect() {},
			async *call(_method, _input, options = {}) {
				entered.resolve(options)
				let status = await terminal.promise
				options.onStatus?.(status)
				if (status.code !== Status.OK) {
					throw new RpcError(status.code, status.details, status.metadata)
				}
				yield* []
			},
			close: vi.fn(),
		},
		close: vi.fn(),
		[Symbol.dispose]() {
			this.close()
		},
	}
	let pool = {
		closed: false,
		snapshot: {
			byNodeId: new Map([[7n, ref]]),
			prefer: [ref],
			fallback: [],
			pessimizedCount: state === 'pessimized' ? 1 : 0,
		} as unknown as RoutingSnapshot,
		acquire(nodeId?: bigint) {
			selections.push({ nodeId, hard: false })
			return connection
		},
		acquireNode(nodeId: bigint) {
			selections.push({ nodeId, hard: true })
			return connection
		},
		callStarted(nodeId: bigint) {
			started.push(nodeId)
		},
		callEnded(nodeId: bigint) {
			ended.push(nodeId)
		},
		penalize(nodeId: bigint) {
			reports.push({ nodeId, ok: false })
		},
		recover(nodeId: bigint) {
			reports.push({ nodeId, ok: true })
		},
	} as unknown as EndpointPool
	return { pool, connection, entered, terminal, started, ended, reports, selections }
}

let metadata = async () => ({ 'x-test': 'value' })

async function finish(f: ReturnType<typeof fixture>, code: Status) {
	let transport = createRoutingTransport(f.pool, metadata)
	let iterator = transport.call(method, {})[Symbol.asyncIterator]()
	let pending = iterator.next()
	await f.entered.promise
	f.terminal.resolve({ code, details: 'test', metadata: {} })
	return pending
}

test.each([Status.UNAVAILABLE, Status.DEADLINE_EXCEEDED])(
	'pessimizes the selected endpoint after status %i',
	async (code) => {
		let f = fixture()
		await expect(finish(f, code)).rejects.toMatchObject({ code })
		expect(f.reports).toEqual([{ nodeId: 7n, ok: false }])
	}
)

test('leaves endpoint health unchanged after a non-pessimizing error', async () => {
	let f = fixture()
	await expect(finish(f, Status.INVALID_ARGUMENT)).rejects.toMatchObject({
		code: Status.INVALID_ARGUMENT,
	})
	expect(f.reports).toEqual([])
})

test('recovers a pessimized endpoint after success', async () => {
	let f = fixture('pessimized')
	await finish(f, Status.OK)
	expect(f.reports).toEqual([{ nodeId: 7n, ok: true }])
})

test('does not emit a recovery event for a healthy endpoint', async () => {
	let f = fixture()
	await finish(f, Status.OK)
	expect(f.reports).toEqual([])
})

test('reports terminal status once and releases the slot after iteration ends', async () => {
	let f = fixture()
	let observed: unknown
	let callback = vi.fn(() => {
		observed = { ended: [...f.ended], reports: [...f.reports] }
	})
	let transport = createRoutingTransport(f.pool, metadata)
	let pending = transport.call(method, {}, { onStatus: callback })[Symbol.asyncIterator]().next()
	let options = await f.entered.promise
	let status = { code: Status.UNAVAILABLE, details: 'offline', metadata: {} }
	options.onStatus?.(status)
	expect(f.ended).toEqual([])
	expect(observed).toEqual({ ended: [], reports: [{ nodeId: 7n, ok: false }] })
	f.terminal.resolve(status)
	await expect(pending).rejects.toMatchObject({ code: Status.UNAVAILABLE })

	expect(f.started).toEqual([7n])
	expect(f.ended).toEqual([7n])
	expect(callback).toHaveBeenCalledOnce()
})

test.each([true, false])('selects the requested node with hard routing %s', async (hard) => {
	let f = fixture()
	let transport = createRoutingTransport(f.pool, metadata, { nodeId: 7n, hard })
	let pending = transport.call(method, {})[Symbol.asyncIterator]().next()
	await f.entered.promise
	f.terminal.resolve({ code: Status.OK, details: '', metadata: {} })
	await pending

	expect(f.selections).toEqual([{ nodeId: 7n, hard }])
})

test('keeps a borrowed connection open when its service client closes', async () => {
	let f = fixture()
	let transport = createRoutingTransport(f.connection, metadata)
	transport.close()

	await expect(transport.call(method, {})[Symbol.asyncIterator]().next()).rejects.toThrow(
		'Client is closed'
	)
	expect(f.connection.close).not.toHaveBeenCalled()
	expect(f.connection.client.close).not.toHaveBeenCalled()
})

test('allows an existing call to finish after its service client closes', async () => {
	let f = fixture()
	let transport = createRoutingTransport(f.pool, metadata)
	let pending = transport.call(method, {})[Symbol.asyncIterator]().next()
	await f.entered.promise
	transport.close()
	f.terminal.resolve({ code: Status.OK, details: '', metadata: {} })

	await expect(pending).resolves.toMatchObject({ done: true })
	expect(f.ended).toEqual([7n])
})

test('rejects new calls after the endpoint pool closes', async () => {
	let f = fixture()
	let transport = createRoutingTransport(f.pool, metadata)
	Object.defineProperty(f.pool, 'closed', { value: true })

	await expect(transport.call(method, {})[Symbol.asyncIterator]().next()).rejects.toThrow(
		'Client is closed'
	)
	expect(f.selections).toEqual([])
})

test('does not select or pessimize an endpoint when authentication fails', async () => {
	let f = fixture()
	let error = new Error('credentials unavailable')
	let transport = createRoutingTransport(f.pool, async () => {
		throw error
	})

	await expect(transport.call(method, {})[Symbol.asyncIterator]().next()).rejects.toBe(error)
	expect(f.selections).toEqual([])
	expect(f.started).toEqual([])
	expect(f.ended).toEqual([])
	expect(f.reports).toEqual([])
})

test('dispatches an RPC even if the onCall hook throws', async () => {
	let f = fixture()
	let transport = createRoutingTransport(f.pool, metadata, {
		hooks: {
			onCall() {
				throw new Error('hook failed')
			},
		},
	})
	let pending = transport.call(method, {})[Symbol.asyncIterator]().next()
	await f.entered.promise
	f.terminal.resolve({ code: Status.OK, details: '', metadata: {} })

	await expect(pending).resolves.toMatchObject({ done: true })
	expect(f.started).toEqual([7n])
	expect(f.ended).toEqual([7n])
})

test('runs completion hooks in the original async context', async () => {
	let f = fixture()
	let storage = new AsyncLocalStorage<string>()
	let contexts: Array<string | undefined> = []
	let completion = vi.fn((event: { grpcStatusCode: number; duration: number }) => {
		contexts.push(storage.getStore())
		expect(event.grpcStatusCode).toBe(Status.OK)
		expect(event.duration).toBeGreaterThanOrEqual(0)
	})
	let transport = createRoutingTransport(f.pool, metadata, {
		hooks: {
			onCall() {
				contexts.push(storage.getStore())
				return completion
			},
		},
	})
	let pending = storage.run('caller', () =>
		transport.call(method, {})[Symbol.asyncIterator]().next()
	)
	let options = await f.entered.promise
	let status = { code: Status.OK, details: '', metadata: {} }
	storage.run('transport', () => options.onStatus?.(status))
	f.terminal.resolve(status)
	await pending

	expect(contexts).toEqual(['caller', 'caller'])
	expect(completion).toHaveBeenCalledOnce()
})
