import { expect, test } from 'vitest'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { AsyncQueue } from '@ydbjs/fsm/queue'

import { SessionRequestRegistry } from './session-registry.ts'
import {
	type SessionStreamRequest,
	type WatchChange,
	type WatchRegistration,
	routeResponse,
	sendPong,
	sendRequest,
	sendStart,
	sendStop,
} from './session-stream.ts'

// ── async queue helpers ────────────────────────────────────────────────────────

// Close the queue and drain all currently buffered items.
// Closing signals the async iterator that there will be no more pushes so
// iteration terminates after the buffered items are exhausted.
let drainQueue = async function drainQueue<T>(queue: AsyncQueue<T>): Promise<T[]> {
	queue.close()
	let items: T[] = []
	for await (let item of queue) {
		items.push(item)
	}
	return items
}

// ── minimal context builders ───────────────────────────────────────────────────

// Build the minimal StreamCtx shape required by send helpers.
let makeSendCtx = function makeSendCtx(overrides?: {
	streamInput?: AsyncQueue<SessionStreamRequest> | null
	sessionId?: bigint | null
	recoveryWindow?: number
	description?: string
	path?: string
}) {
	return {
		client: null as never,
		signal: undefined,
		streamAbortController: null,
		streamIngest: null,
		requests: new SessionRequestRegistry(),
		watchesByName: new Map(),
		watchesByReqId: new Map(),
		sessionId: overrides?.sessionId ?? null,
		streamInput:
			overrides?.streamInput !== undefined
				? overrides.streamInput
				: new AsyncQueue<SessionStreamRequest>(),
		options: {
			path: overrides?.path ?? '/test/node',
			...(overrides?.recoveryWindow !== undefined
				? { recoveryWindow: overrides.recoveryWindow }
				: {}),
			...(overrides?.description !== undefined ? { description: overrides.description } : {}),
		},
	}
}

// Build the minimal StreamCtx shape required by routeResponse.
let makeRouteCtx = function makeRouteCtx(overrides?: {
	requests?: SessionRequestRegistry
	watchesByName?: Map<string, WatchRegistration>
	watchesByReqId?: Map<bigint, { name: string; queue: AsyncQueue<WatchChange> }>
}) {
	return {
		client: null as never,
		signal: undefined,
		streamInput: null,
		streamAbortController: null,
		streamIngest: null,
		sessionId: null,
		options: { path: '/test/node' },
		requests: overrides?.requests ?? new SessionRequestRegistry(),
		watchesByName: overrides?.watchesByName ?? new Map(),
		watchesByReqId: overrides?.watchesByReqId ?? new Map(),
	}
}

// ── sendRequest ────────────────────────────────────────────────────────────────

test('sendRequest pushes message to open streamInput', async () => {
	let queue = new AsyncQueue<SessionStreamRequest>()
	let ctx = makeSendCtx({ streamInput: queue })

	let msg: SessionStreamRequest = { request: { case: 'sessionStop', value: {} } }
	sendRequest(ctx, msg)

	expect(queue.size).toBe(1)
	let items = await drainQueue(queue)
	expect(items[0]).toBe(msg)
})

test('sendRequest silently skips when streamInput is null', () => {
	let ctx = makeSendCtx({ streamInput: null })
	// Must not throw even though there is nowhere to send.
	expect(() => sendRequest(ctx, { request: { case: 'sessionStop', value: {} } })).not.toThrow()
})

test('sendRequest silently skips when streamInput is closed', () => {
	let queue = new AsyncQueue<SessionStreamRequest>()
	queue.close()
	let ctx = makeSendCtx({ streamInput: queue })

	expect(() => sendRequest(ctx, { request: { case: 'sessionStop', value: {} } })).not.toThrow()
	expect(queue.size).toBe(0)
})

test('sendRequest silently skips when streamInput is destroyed', () => {
	let queue = new AsyncQueue<SessionStreamRequest>()
	queue.destroy()
	let ctx = makeSendCtx({ streamInput: queue })

	expect(() => sendRequest(ctx, { request: { case: 'sessionStop', value: {} } })).not.toThrow()
	expect(queue.size).toBe(0)
})

// ── sendStart ─────────────────────────────────────────────────────────────────

test('sendStart enqueues a sessionStart message', async () => {
	let queue = new AsyncQueue<SessionStreamRequest>()
	let ctx = makeSendCtx({ streamInput: queue, path: '/coord/locks' })

	sendStart(ctx)

	expect(queue.size).toBe(1)
	let items = await drainQueue(queue)
	expect(items[0]?.request.case).toBe('sessionStart')
})

test('sendStart uses path from options', async () => {
	let queue = new AsyncQueue<SessionStreamRequest>()
	let ctx = makeSendCtx({ streamInput: queue, path: '/my/path' })

	sendStart(ctx)

	let [item] = await drainQueue(queue)
	expect((item!.request.value as { path: string }).path).toBe('/my/path')
})

test('sendStart uses sessionId 0n when ctx.sessionId is null', async () => {
	let queue = new AsyncQueue<SessionStreamRequest>()
	let ctx = makeSendCtx({ streamInput: queue, sessionId: null })

	sendStart(ctx)

	let [item] = await drainQueue(queue)
	expect((item!.request.value as { sessionId: bigint }).sessionId).toBe(0n)
})

test('sendStart uses existing sessionId on reconnect', async () => {
	let queue = new AsyncQueue<SessionStreamRequest>()
	let ctx = makeSendCtx({ streamInput: queue, sessionId: 7n })

	sendStart(ctx)

	let [item] = await drainQueue(queue)
	expect((item!.request.value as { sessionId: bigint }).sessionId).toBe(7n)
})

test('sendStart sets timeoutMillis from recoveryWindow option', async () => {
	let queue = new AsyncQueue<SessionStreamRequest>()
	let ctx = makeSendCtx({ streamInput: queue, recoveryWindow: 10_000 })

	sendStart(ctx)

	let [item] = await drainQueue(queue)
	expect((item!.request.value as { timeoutMillis: bigint }).timeoutMillis).toBe(10_000n)
})

test('sendStart defaults timeoutMillis to 30_000 when recoveryWindow is absent', async () => {
	let queue = new AsyncQueue<SessionStreamRequest>()
	let ctx = makeSendCtx({ streamInput: queue })

	sendStart(ctx)

	let [item] = await drainQueue(queue)
	expect((item!.request.value as { timeoutMillis: bigint }).timeoutMillis).toBe(30_000n)
})

test('sendStart sets description from options', async () => {
	let queue = new AsyncQueue<SessionStreamRequest>()
	let ctx = makeSendCtx({ streamInput: queue, description: 'my-session' })

	sendStart(ctx)

	let [item] = await drainQueue(queue)
	expect((item!.request.value as { description: string }).description).toBe('my-session')
})

test('sendStart defaults description to empty string when absent', async () => {
	let queue = new AsyncQueue<SessionStreamRequest>()
	let ctx = makeSendCtx({ streamInput: queue })

	sendStart(ctx)

	let [item] = await drainQueue(queue)
	expect((item!.request.value as { description: string }).description).toBe('')
})

// ── sendStop ──────────────────────────────────────────────────────────────────

test('sendStop enqueues a sessionStop message', async () => {
	let queue = new AsyncQueue<SessionStreamRequest>()
	let ctx = makeSendCtx({ streamInput: queue })

	sendStop(ctx)

	expect(queue.size).toBe(1)
	let [item] = await drainQueue(queue)
	expect(item?.request.case).toBe('sessionStop')
})

// ── sendPong ──────────────────────────────────────────────────────────────────

test('sendPong enqueues a pong message with the given opaque value', async () => {
	let queue = new AsyncQueue<SessionStreamRequest>()
	let ctx = makeSendCtx({ streamInput: queue })

	sendPong(ctx, 99n)

	expect(queue.size).toBe(1)
	let [item] = await drainQueue(queue)
	expect(item!.request.case).toBe('pong')
	expect((item!.request.value as { opaque: bigint }).opaque).toBe(99n)
})

// ── routeResponse — protocol events ───────────────────────────────────────────

test('routeResponse returns ping event for ping message', () => {
	let ctx = makeRouteCtx()
	let response = {
		response: { case: 'ping', value: { opaque: 5n } },
	} as never

	let event = routeResponse(ctx, response)

	expect(event).toEqual({ type: 'session.stream.response.ping', opaque: 5n })
})

test('routeResponse returns started event for sessionStarted message', () => {
	let ctx = makeRouteCtx()
	let response = {
		response: { case: 'sessionStarted', value: { sessionId: 42n } },
	} as never

	let event = routeResponse(ctx, response)

	expect(event).toEqual({ type: 'session.stream.response.started', sessionId: 42n })
})

test('routeResponse returns stopped event for sessionStopped message', () => {
	let ctx = makeRouteCtx()
	let response = {
		response: { case: 'sessionStopped', value: { sessionId: 42n } },
	} as never

	let event = routeResponse(ctx, response)

	expect(event).toEqual({ type: 'session.stream.response.stopped', sessionId: 42n })
})

test('routeResponse returns failure event for failure message', () => {
	let ctx = makeRouteCtx()
	let issues = [{ message: 'oops' }]
	let response = {
		response: {
			case: 'failure',
			value: { status: StatusIds_StatusCode.BAD_SESSION, issues },
		},
	} as never

	let event = routeResponse(ctx, response)

	expect(event).toEqual({
		type: 'session.stream.response.failure',
		status: StatusIds_StatusCode.BAD_SESSION,
		issues,
	})
})

test('routeResponse returns null for an unrecognized response case', () => {
	let ctx = makeRouteCtx()
	let response = { response: { case: 'unknown_future_case', value: {} } } as never

	expect(routeResponse(ctx, response)).toBeNull()
})

// ── routeResponse — request-response messages ─────────────────────────────────

test('routeResponse resolves createSemaphoreResult deferred and returns null', async () => {
	let registry = new SessionRequestRegistry()
	let reqId = registry.nextReqId()
	let deferred = registry.register(reqId)
	let ctx = makeRouteCtx({ requests: registry })

	let response = {
		response: { case: 'createSemaphoreResult', value: { reqId } },
	} as never

	let event = routeResponse(ctx, response)

	expect(event).toBeNull()
	await expect(deferred.promise).resolves.toBe(response)
})

test('routeResponse resolves updateSemaphoreResult deferred and returns null', async () => {
	let registry = new SessionRequestRegistry()
	let reqId = registry.nextReqId()
	let deferred = registry.register(reqId)
	let ctx = makeRouteCtx({ requests: registry })

	let response = {
		response: { case: 'updateSemaphoreResult', value: { reqId } },
	} as never

	expect(routeResponse(ctx, response)).toBeNull()
	await expect(deferred.promise).resolves.toBe(response)
})

test('routeResponse resolves deleteSemaphoreResult deferred and returns null', async () => {
	let registry = new SessionRequestRegistry()
	let reqId = registry.nextReqId()
	let deferred = registry.register(reqId)
	let ctx = makeRouteCtx({ requests: registry })

	let response = {
		response: { case: 'deleteSemaphoreResult', value: { reqId } },
	} as never

	expect(routeResponse(ctx, response)).toBeNull()
	await expect(deferred.promise).resolves.toBe(response)
})

test('routeResponse resolves describeSemaphoreResult deferred and returns null', async () => {
	let registry = new SessionRequestRegistry()
	let reqId = registry.nextReqId()
	let deferred = registry.register(reqId)
	let ctx = makeRouteCtx({ requests: registry })

	let response = {
		response: { case: 'describeSemaphoreResult', value: { reqId, semaphoreDescription: {} } },
	} as never

	expect(routeResponse(ctx, response)).toBeNull()
	await expect(deferred.promise).resolves.toBe(response)
})

test('routeResponse resolves acquireSemaphorePending deferred and returns null', async () => {
	let registry = new SessionRequestRegistry()
	let reqId = registry.nextReqId()
	let deferred = registry.register(reqId)
	let ctx = makeRouteCtx({ requests: registry })

	let response = {
		response: { case: 'acquireSemaphorePending', value: { reqId } },
	} as never

	expect(routeResponse(ctx, response)).toBeNull()
	await expect(deferred.promise).resolves.toBe(response)
})

test('routeResponse resolves acquireSemaphoreResult deferred and returns null', async () => {
	let registry = new SessionRequestRegistry()
	let reqId = registry.nextReqId()
	let deferred = registry.register(reqId)
	let ctx = makeRouteCtx({ requests: registry })

	let response = {
		response: { case: 'acquireSemaphoreResult', value: { reqId, acquired: true } },
	} as never

	expect(routeResponse(ctx, response)).toBeNull()
	await expect(deferred.promise).resolves.toBe(response)
})

test('routeResponse resolves releaseSemaphoreResult deferred and returns null', async () => {
	let registry = new SessionRequestRegistry()
	let reqId = registry.nextReqId()
	let deferred = registry.register(reqId)
	let ctx = makeRouteCtx({ requests: registry })

	let response = {
		response: { case: 'releaseSemaphoreResult', value: { reqId, released: true } },
	} as never

	expect(routeResponse(ctx, response)).toBeNull()
	await expect(deferred.promise).resolves.toBe(response)
})

test('routeResponse returns null for request-response with unknown reqId', () => {
	// registry has no registrations — resolve() returns false.
	// routeResponse falls through to the protocol-message checks and finds nothing.
	let ctx = makeRouteCtx()
	let response = {
		response: { case: 'createSemaphoreResult', value: { reqId: 999n } },
	} as never

	expect(routeResponse(ctx, response)).toBeNull()
})

// ── routeResponse — watch change notifications ─────────────────────────────────

test('routeResponse pushes describeSemaphoreChanged to active watch queue and returns null', async () => {
	let queue = new AsyncQueue<WatchChange>()
	let reqId = 1n

	let watchesByName = new Map<string, WatchRegistration>([
		['my-sem', { queue, reqId, signalController: new AbortController() }],
	])
	let watchesByReqId = new Map([[reqId, { name: 'my-sem', queue }]])
	let ctx = makeRouteCtx({ watchesByName, watchesByReqId })

	let response = {
		response: {
			case: 'describeSemaphoreChanged',
			value: { reqId, dataChanged: true, ownersChanged: false },
		},
	} as never

	let event = routeResponse(ctx, response)

	expect(event).toBeNull()
	expect(queue.size).toBe(1)

	let [change] = await drainQueue(queue)
	expect(change).toEqual({ dataChanged: true, ownersChanged: false })
})

test('routeResponse ignores describeSemaphoreChanged when reqId not in watchesByReqId', () => {
	let ctx = makeRouteCtx()
	let response = {
		response: {
			case: 'describeSemaphoreChanged',
			value: { reqId: 77n, dataChanged: true, ownersChanged: true },
		},
	} as never

	expect(routeResponse(ctx, response)).toBeNull()
})

test('routeResponse ignores describeSemaphoreChanged when watch registration is stale', () => {
	// watchesByReqId points to a queue that no longer matches watchesByName
	// (the active registration was replaced with a newer one).
	let oldQueue = new AsyncQueue<WatchChange>()
	let newQueue = new AsyncQueue<WatchChange>()
	let reqId = 1n

	let watchesByName = new Map<string, WatchRegistration>([
		// Active registration uses a newer reqId and a different queue.
		['my-sem', { queue: newQueue, reqId: 2n, signalController: new AbortController() }],
	])
	// reqId 1 still maps to the old queue — stale entry.
	let watchesByReqId = new Map([[reqId, { name: 'my-sem', queue: oldQueue }]])
	let ctx = makeRouteCtx({ watchesByName, watchesByReqId })

	let response = {
		response: {
			case: 'describeSemaphoreChanged',
			value: { reqId, dataChanged: true, ownersChanged: false },
		},
	} as never

	routeResponse(ctx, response)

	// Neither queue should have received a change.
	expect(oldQueue.size).toBe(0)
	expect(newQueue.size).toBe(0)
})
