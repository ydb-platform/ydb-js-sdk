import { subscribe, unsubscribe } from 'node:diagnostics_channel'
import { getEventListeners } from 'node:events'

import { expect, test, vi } from 'vitest'

import { createTopicReader } from './index.ts'
import {
	initResponse,
	makeFakeTopicDriver,
	partitionStatusResponse,
	settle,
	startPartitionSession,
	stopPartitionSession,
} from './reader.fixtures.ts'
import { ReaderTransport } from './transport.ts'

// Resource-lifecycle coverage for the reader against the fake wire, mirroring the
// writer's leak tests in writer.contract.test.ts: create/destroy churn must stay flat
// in memory, finished readers must be GC-reclaimable, and a shared long-lived abort
// signal must not accumulate listeners across lifecycles. The suite runs with
// --expose-gc (see vitest.config.ts), so globalThis.gc is available.

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
	let { driver } = makeFakeTopicDriver()
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
