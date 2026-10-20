import { subscribe, unsubscribe } from 'node:diagnostics_channel'
import { getEventListeners } from 'node:events'
import type { StreamReadMessage_FromClient } from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'

import { expect, test, vi } from 'vitest'

import { createTopicReader } from './index.ts'
import {
	initResponse,
	makeFakeTopicDriver,
	partitionStatusResponse,
	readResponse,
	settle,
	startPartitionSession,
	stopPartitionSession,
} from './reader.fixtures.ts'
import { ReaderTransport } from './transport.ts'

// The fake separates reader-owned references, timers, and microtasks from transport resources.

// Synchronous callback reentry must not publish another lifecycle event after destruction.
test.for(['committed', 'stopped'] as const)(
	'stops lifecycle notifications when the $0 callback destroys the reader',
	async (event) => {
		let { driver, waitForNextStream } = makeFakeTopicDriver()
		let reason = new Error('Stopped by callback')
		using reader = createTopicReader(driver, {
			topic: '/t',
			consumer: 'c',
			onCommittedOffset: () => {
				if (event === 'committed') reader.destroy(reason)
			},
			onPartitionSessionStop: async () => {
				if (event === 'stopped') reader.destroy(reason)
			},
		})
		let stream = await waitForNextStream()
		await stream.waitForInit()
		stream.respond(initResponse())
		await stream.waitForReadRequest()
		stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 0n }))
		await stream.waitForStartResponse()
		let events: string[] = []
		let channels = [
			'ydb:topic.reader.closed',
			'ydb:topic.reader.committed',
			'ydb:topic.reader.partition.stopped',
		]
		let record = (value: unknown, name: string | symbol) => {
			if ((value as { driver: unknown }).driver === driver.identity) events.push(String(name))
		}
		for (let name of channels) subscribe(name, record)
		try {
			stream.respond(
				event === 'committed'
					? partitionStatusResponse(1n, 1n)
					: stopPartitionSession({ partitionSessionId: 1n, graceful: false })
			)
			await settle()
			expect(events).toEqual(['ydb:topic.reader.closed'])
			expect(stream.wasAborted()).toBe(true)
			let next = reader.read()[Symbol.asyncIterator]().next()
			await expect(next).rejects.toBe(reason)
		} finally {
			for (let name of channels) unsubscribe(name, record)
		}
	}
)

test('stops immediately without opening a stream after destruction', async () => {
	vi.useFakeTimers()
	try {
		let { driver } = makeFakeTopicDriver()
		using createClient = vi.spyOn(driver, 'createClient')
		using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
		let reason = new Error('Stopped before initialization')
		reader.destroy(reason)
		expect(vi.getTimerCount()).toBe(0)
		await settle()
		expect(createClient).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
		let next = reader.read()[Symbol.asyncIterator]().next()
		await expect(next).rejects.toBe(reason)
	} finally {
		vi.useRealTimers()
	}
})

// A server failure is a protocol event; only an injected effect exception can
// deterministically exercise the runtime's fault path without a terminal transition.
test('closes the stream and clears timers when a reader effect throws', async () => {
	vi.useFakeTimers()
	try {
		let { driver, waitForNextStream } = makeFakeTopicDriver()
		using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
		let stream = await waitForNextStream()
		await stream.waitForInit()
		let error = new Error('Injected transport send failure')
		using send = vi.spyOn(ReaderTransport.prototype, 'send').mockImplementation(() => {
			throw error
		})
		stream.respond(initResponse())
		await settle()
		expect(stream.wasAborted()).toBe(true)
		expect(vi.getTimerCount()).toBe(0)
		await expect(reader.close()).rejects.toBe(error)
		await vi.advanceTimersByTimeAsync(60_000)
		expect(send).toHaveBeenCalledTimes(1)
	} finally {
		vi.useRealTimers()
	}
})

test('preserves a zero destroy reason for reads commits and close', async () => {
	using driver = new Driver('grpc://127.0.0.1:1/local', {
		'ydb.sdk.enable_discovery': false,
	})
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	reader.destroy(0)
	let iterator = reader.read()[Symbol.asyncIterator]()
	await expect(iterator.next()).rejects.toBe(0)
	await expect(reader.commit([])).rejects.toBe(0)
	await expect(reader.close()).rejects.toBe(0)
})

test('releases the live transport and every timer before graceful close resolves', async () => {
	vi.useFakeTimers()
	try {
		let { driver, waitForNextStream } = makeFakeTopicDriver()
		using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
		let stream = await waitForNextStream()
		await stream.waitForInit()
		stream.respond(initResponse())
		await stream.waitForReadRequest()
		expect(vi.getTimerCount()).toBeGreaterThan(0)
		await reader.close()
		expect(stream.wasAborted()).toBe(true)
		expect(vi.getTimerCount()).toBe(0)
	} finally {
		vi.useRealTimers()
	}
})

// Bring one reader to `ready`, then destroy it. Returns nothing so the
// reader/driver/stream locals leave the stack and become collectable.
let spinUpAndDestroy = async function spinUpAndDestroy(): Promise<void> {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse())
	await stream.waitForReadRequest()
	reader.destroy()
	await settle(2)
}

test('does not leak across 10k reader lifecycles', { timeout: 240_000 }, async () => {
	// A leak (uncleared timers, retained closures, dangling listeners, un-freed
	// buffers) grows the heap roughly linearly with the number of created-and-
	// destroyed readers. A healthy run stays flat.
	let cycles = 10_000

	// Warm up so steady-state allocations (module caches etc.) don't count.
	for (let i = 0; i < 500; i++) {
		// oxlint-disable-next-line no-await-in-loop
		await spinUpAndDestroy()
	}
	globalThis.gc?.()
	let before = process.memoryUsage().heapUsed

	for (let i = 0; i < cycles; i++) {
		// oxlint-disable-next-line no-await-in-loop
		await spinUpAndDestroy()
	}
	globalThis.gc?.()
	let after = process.memoryUsage().heapUsed

	// 10k leaked readers (each holding a machine, transport, queues and timers) would
	// add tens of MB; a healthy run stays within a few MB of steady-state
	// fragmentation. Generous bound to avoid GC noise.
	expect(after - before).toBeLessThan(16 * 1024 * 1024)
})

// The node-idiomatic reclaim check (see writer.contract.test.ts): a
// FinalizationRegistry callback fires only once the object is actually reclaimed.
// (A polled WeakRef.deref() loop is wrong here — each deref keeps the target alive
// for the current job and prevents collection.)
let destroyAndRegister = async function destroyAndRegister(
	registry: FinalizationRegistry<string>
): Promise<void> {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse())
	await stream.waitForReadRequest()
	reader.destroy()
	await settle(2)
	registry.register(reader, 'reader')
	// Returning drops every strong local (reader/driver/stream) off the stack.
}

test('reclaims a destroyed reader with no lingering references', async () => {
	let observation = {
		collected: false,
		registry: new FinalizationRegistry<string>(() => {
			observation.collected = true
		}),
	}

	await destroyAndRegister(observation.registry)

	// Keep the registry reachable together with the result until finalization is observed.
	// oxlint-disable-next-line no-unmodified-loop-condition
	for (let i = 0; i < 50 && !observation.collected; i++) {
		globalThis.gc?.()
		// oxlint-disable-next-line no-await-in-loop
		await new Promise((resolve) => setTimeout(resolve, 10))
	}

	expect(observation.collected).toBe(true)
})

// Same reclaim check for the graceful path: close() drains and terminates, after
// which nothing (timers, ingest loops, the consume drain) may pin the reader.
let closeAndRegister = async function closeAndRegister(
	registry: FinalizationRegistry<string>
): Promise<void> {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse())
	await stream.waitForReadRequest()
	await reader.close()
	await settle(2)
	registry.register(reader, 'reader')
}

test('reclaims a gracefully closed reader with no lingering references', async () => {
	let observation = {
		collected: false,
		registry: new FinalizationRegistry<string>(() => {
			observation.collected = true
		}),
	}

	await closeAndRegister(observation.registry)

	// oxlint-disable-next-line no-unmodified-loop-condition
	for (let i = 0; i < 50 && !observation.collected; i++) {
		globalThis.gc?.()
		// oxlint-disable-next-line no-await-in-loop
		await new Promise((resolve) => setTimeout(resolve, 10))
	}

	expect(observation.collected).toBe(true)
})

// One reader lifecycle threading a shared signal through a read() window: #nextChunk
// attaches an abort listener for its race and must detach it when the window elapses.
let cycleWithSharedSignal = async function cycleWithSharedSignal(
	signal: AbortSignal
): Promise<void> {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using reader = createTopicReader(driver, { topic: '/t', consumer: 'c' })
	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse())
	await stream.waitForReadRequest()

	let iterator = reader.read({ batchWindowMs: 1, signal })[Symbol.asyncIterator]()
	await iterator.next() // one idle window: listener attached, raced, detached
	await iterator.return?.()

	reader.destroy()
	await settle(2)
}

test('keeps abort listeners flat on a shared signal across reader lifecycles', async () => {
	// A long-lived app threads ONE shutdown/request signal into every read(). If the
	// reader failed to detach its abort listener when a window settles, the signal
	// would gain a listener per lifecycle — the classic signal-chain leak (the reason
	// AbortSignal.any is banned here). The count must stay flat.
	let ac = new AbortController()

	for (let i = 0; i < 100; i++) {
		// oxlint-disable-next-line no-await-in-loop
		await cycleWithSharedSignal(ac.signal)
	}

	// Every settled window detached its listener — no accumulation on the shared signal.
	expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0)
})

let bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

function readRequests(sent: StreamReadMessage_FromClient[]): bigint[] {
	let requests: bigint[] = []
	for (let { clientMessage } of sent) {
		if (clientMessage.case === 'readRequest') requests.push(clientMessage.value.bytesSize)
	}
	return requests
}

async function primeStream(
	waitForNextStream: ReturnType<typeof makeFakeTopicDriver>['waitForNextStream'],
	sessionId = 'session-A'
) {
	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(sessionId))
	await stream.waitForReadRequest()
	return stream
}

// The fake isolates a hook completion after synchronous teardown from network cancellation.
test('ignores a hook that resolves after the reader is destroyed', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let hookGate = Promise.withResolvers<void>()
	let unhandled: unknown[] = []
	let onUnhandled = (reason: unknown) => {
		unhandled.push(reason)
	}
	process.on('unhandledRejection', onUnhandled)

	try {
		let reader = createTopicReader(driver, {
			topic: '/t',
			consumer: 'c',
			onPartitionSessionStart: async () => {
				await hookGate.promise
				return undefined
			},
		})

		let stream = await waitForNextStream()
		await stream.waitForInit()
		stream.respond(initResponse('session-A'))
		await stream.waitForReadRequest()
		stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 0n }))
		await new Promise((resolve) => setTimeout(resolve, 10))

		reader.destroy()
		hookGate.resolve()
		await new Promise((resolve) => setTimeout(resolve, 25))

		expect(
			stream.sent.some((m) => m.clientMessage.case === 'startPartitionSessionResponse')
		).toBe(false)
		expect(unhandled).toEqual([])
	} finally {
		process.off('unhandledRejection', onUnhandled)
	}
})

// The fake schedules the stale and current hooks independently after reusing a per-stream partition id.
test('answers a re-granted partition exactly once when the previous stream hook finishes late', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let calls: PromiseWithResolvers<void>[] = []
	using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		onPartitionSessionStart: () => {
			let d = Promise.withResolvers<void>()
			calls.push(d)
			return d.promise.then(() => undefined)
		},
	})
	void reader

	let stream1 = await primeStream(waitForNextStream, 'session-A')
	stream1.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 10n }))
	await settle()
	expect(calls).toHaveLength(1) // hook 1 running (slow)

	stream1.disconnect()

	let stream2 = await waitForNextStream()
	await stream2.waitForInit()
	stream2.respond(initResponse('session-B'))
	await stream2.waitForReadRequest()
	// Same partition, same per-stream session id 1 — the common case (server assign
	// ids restart at 1 per stream). Only the grant epoch tells the hooks apart; a
	// second StartPartitionSessionResponse for one assign id is session-fatal
	// ("double partition locking", BAD_REQUEST).
	stream2.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 10n }))
	await settle()
	expect(calls).toHaveLength(2) // hook 2 running

	// The STALE hook (stream 1) completes first, then the current one.
	calls[0]!.resolve()
	await settle()
	calls[1]!.resolve()
	await settle()

	let responses = stream2.sent.filter(
		(m) => m.clientMessage.case === 'startPartitionSessionResponse'
	)
	expect(responses).toHaveLength(1)
})

// Microtask control places cancellation after dequeue but before the batch window yields.
test('does not release a response when the signal aborts before yield', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	await using reader = createTopicReader(driver, {
		topic: '/t',
		consumer: 'c',
		maxBufferBytes: 1000n,
	})
	let stream = await primeStream(waitForNextStream)
	stream.respond(startPartitionSession({ partitionSessionId: 1n, partitionId: 10n }))
	await stream.waitForStartResponse()
	stream.respond(
		readResponse({
			partitionSessionId: 1n,
			messages: [{ offset: 0n, seqNo: 1n, data: bytes('a') }],
			bytesSize: 400n,
		})
	)
	await settle()

	// Long window with limit unset: the response leaves the transport queue, but the
	// iterable has not yielded it yet when the signal aborts.
	let ac = new AbortController()
	let thrown: unknown
	let consume = (async () => {
		try {
			for await (let batch of reader.read({ batchWindowMs: 60_000, signal: ac.signal })) {
				void batch
			}
		} catch (error) {
			thrown = error
		}
	})()
	// Let the loop consume the buffered chunk, then abort mid-window.
	await settle()
	ac.abort(new Error('consumer aborted'))
	await consume
	expect(String(thrown)).toContain('consumer aborted')
	await settle()

	// No iterable value was received, so no read credit is returned yet.
	expect(readRequests(stream.sent)).toEqual([1000n])

	// A later read receives the carried response and releases its credit then.
	for await (let batch of reader.read({ limit: 1 })) {
		expect(batch.map((message) => message.offset)).toEqual([0n])
		break
	}
	await settle()
	expect(readRequests(stream.sent)).toEqual([1000n, 400n])
})
