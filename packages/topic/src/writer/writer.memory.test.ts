import { getEventListeners } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'

import type { Driver } from '@ydbjs/core'
import { type TestContext, expect, test, vi } from 'vitest'

import { GZIP_CODEC, RAW_CODEC } from '../codec.ts'
import { initResponse, makeFakeTopicDriver, settle, writeResponse } from './writer.fixtures.ts'
import { type TopicWriter, createTopicWriter } from './writer.ts'

let capturingWriter = function capturingWriter(
	driver: Driver,
	owner: 'onAck' | 'codec',
	registry: FinalizationRegistry<void>,
	acks: bigint[]
): TopicWriter {
	let captured = new Uint8Array(16 * 1024 * 1024)
	registry.register(captured.buffer, undefined)
	return createTopicWriter(driver, {
		topic: '/t',
		onAck:
			owner === 'onAck'
				? (seqNo) => {
						if (captured[0] !== 0) {
							throw new Error('Unexpected callback state')
						}
						acks.push(seqNo)
					}
				: (seqNo) => {
						acks.push(seqNo)
					},
		codec:
			owner === 'codec'
				? {
						codec: RAW_CODEC.codec,
						compress(data) {
							if (captured[0] !== 0) {
								throw new Error('Unexpected codec state')
							}
							return data
						},
						decompress: RAW_CODEC.decompress,
					}
				: RAW_CODEC,
	})
}

// The fake releases the final ACK deterministically; the assertion measures reachability,
// independent of gRPC allocations, RSS caching, or whether the writer itself gets collected.
let verifyReleasedCapture = async function verifyReleasedCapture(
	owner: 'onAck' | 'codec',
	tc: TestContext
): Promise<{ collected: boolean; acks: bigint[]; writer: TopicWriter }> {
	let collected = false
	let registry = new FinalizationRegistry<void>(() => {
		collected = true
	})
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let acks: bigint[] = []
	using writer = capturingWriter(driver, owner, registry, acks)
	let stream = await waitForNextStream()
	stream.respond(initResponse(0n))
	writer.write(new Uint8Array([1]))
	let closed = writer.close(tc.signal)
	await stream.waitForWrite()
	stream.respond(writeResponse([{ seqNo: 1n }]))
	await closed

	// The registry callback updates this condition between GC rounds.
	// oxlint-disable-next-line no-unmodified-loop-condition
	for (let attempt = 0; attempt < 40 && !collected; attempt++) {
		globalThis.gc!()
		// oxlint-disable-next-line no-await-in-loop
		await sleep(10, undefined, { signal: tc.signal })
	}
	await writer.close(tc.signal)
	return { collected, acks, writer }
}

test('releases onAck captures while a closed writer remains reachable', async (tc) => {
	let result = await verifyReleasedCapture('onAck', tc)
	expect(result).toMatchObject({ collected: true, acks: [1n] })
	await expect(result.writer.close(tc.signal)).resolves.toBeUndefined()
})

test('releases custom codec captures while a closed writer remains reachable', async (tc) => {
	let result = await verifyReleasedCapture('codec', tc)
	expect(result).toMatchObject({ collected: true, acks: [1n] })
	await expect(result.writer.close(tc.signal)).resolves.toBeUndefined()
})

let bytes = (...values: number[]) => new Uint8Array(values)

// These tests inspect writer-owned references and allocations; wire serialization would replace them.
let spinUpAndDestroy = async function spinUpAndDestroy(): Promise<void> {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })
	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(0n))
	await settle(2)
	writer.write(bytes(1))
	writer.destroy()
	await settle(2)
}

test('does not leak across 50k writer lifecycles', { timeout: 240_000 }, async () => {
	// A leak (uncleared timers, retained closures, dangling listeners, un-freed
	// buffers) grows the heap roughly linearly with the number of created-and-
	// destroyed writers. A healthy run stays flat.
	let cycles = 50_000

	// Warm up so steady-state allocations (module caches etc.) don't count.
	for (let i = 0; i < 1000; i++) {
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

	// 50k leaked writers would add hundreds of MB; a healthy run stays within a
	// few MB of steady-state fragmentation. Generous bound to avoid GC noise.
	expect(after - before).toBeLessThan(16 * 1024 * 1024)
})

// Bun's memory-leak idiom (bun:jsc heapStats().objectTypeCounts) forces GC and
// asserts a class's live instance count returned to baseline. The node-idiomatic
// equivalent: a FinalizationRegistry callback fires only once the object is
// actually reclaimed. (A polled WeakRef.deref() loop is wrong here — each deref
// keeps the target alive for the current job and prevents collection.)
let registerForCollection = async function registerForCollection(
	registry: FinalizationRegistry<string>
): Promise<void> {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })
	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(0n))
	await settle(2)
	writer.write(bytes(1))
	writer.destroy()
	await settle(2)
	registry.register(writer as unknown as object, 'writer')
	// Returning drops every strong local (writer/driver/stream) off the stack.
}

test('reclaims a destroyed writer with no lingering references', async () => {
	let observation = {
		collected: false,
		registry: new FinalizationRegistry<string>(() => {
			observation.collected = true
		}),
	}

	await registerForCollection(observation.registry)

	// Keep the registry reachable together with the result until finalization is observed.
	// oxlint-disable-next-line no-unmodified-loop-condition
	for (let i = 0; i < 50 && !observation.collected; i++) {
		globalThis.gc?.()
		// oxlint-disable-next-line no-await-in-loop
		await new Promise((resolve) => setTimeout(resolve, 10))
	}

	expect(observation.collected).toBe(true)
})

// ── review fixes ─────────────────────────────────────────────────────────────────

test('keeps abort listeners flat across flushes on a long-lived signal', async () => {
	// A long-lived app threads ONE shutdown/request signal into every flush(). If
	// abortable() failed to detach its abort listener when the flush settles, the
	// signal would gain a listener per flush — the classic signal-chain leak (the
	// reason AbortSignal.any is banned here). The count must stay flat.
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(0n))
	await settle()

	let ac = new AbortController()
	for (let i = 1; i <= 200; i++) {
		writer.write(bytes(1))
		let flushed = writer.flush(ac.signal)
		// oxlint-disable-next-line no-await-in-loop
		await settle()
		stream.respond(writeResponse([{ seqNo: BigInt(i) }]))
		// oxlint-disable-next-line no-await-in-loop
		await flushed
	}

	// Every settled flush detached its listener — no accumulation on the shared signal.
	expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0)
})

test('frees the flush waiter on every abort of a global signal', async () => {
	// The internal flush waiter must be dropped on abort. Otherwise a long-lived
	// aborted signal threaded into many flush() calls piles up waiters that reject
	// unhandled on terminate — Vitest fails the run on any unhandled rejection.
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(0n))
	await settle()

	let ac = new AbortController()
	ac.abort(new Error('shutdown'))

	for (let i = 0; i < 200; i++) {
		writer.write(bytes(1))
		// oxlint-disable-next-line no-await-in-loop
		await expect(writer.flush(ac.signal)).rejects.toThrow('shutdown')
	}

	// No accumulated waiters → terminate rejects nothing → no unhandled rejection.
	writer.destroy()
	await settle()
})

// ── destroy / dispose: unusable + freed ────────────────────────────────────────

let disposeAndRegister = async function disposeAndRegister(
	registry: FinalizationRegistry<string>
): Promise<void> {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })
	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(0n))
	await settle(2)
	await writer[Symbol.asyncDispose]()
	await settle(2)
	registry.register(writer as unknown as object, 'writer')
}

test('reclaims a gracefully disposed writer with no lingering references', async () => {
	let observation = {
		collected: false,
		registry: new FinalizationRegistry<string>(() => {
			observation.collected = true
		}),
	}

	await disposeAndRegister(observation.registry)

	// oxlint-disable-next-line no-unmodified-loop-condition
	for (let i = 0; i < 50 && !observation.collected; i++) {
		globalThis.gc?.()
		// oxlint-disable-next-line no-await-in-loop
		await new Promise((resolve) => setTimeout(resolve, 10))
	}

	expect(observation.collected).toBe(true)
})

test('stays flat in memory across ~1M written+acked messages', { timeout: 240_000 }, async () => {
	// The steady-state leak test the lifecycle test can't catch: a single writer that
	// writes forever. Each chunk is written, sent, fully acked and drained, so the
	// sliding window must compact back to empty — a leak (window not compacting,
	// retained payloads/Dates/protobufs, waiter/output buildup) would grow the heap
	// roughly linearly with the ~1M total messages.
	let CHUNK = 10_000
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using writer = createTopicWriter(driver, {
		topic: '/t',
		producer: 'p',
		maxInflightCount: CHUNK, // whole chunk goes inflight, one ack batch drains it
	})

	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(0n))
	await settle()

	let payload = new Uint8Array(16) // reused → we measure writer retention, not payloads
	let nextSeqNo = 1n

	let driveChunk = async function driveChunk(): Promise<void> {
		for (let i = 0; i < CHUNK; i++) {
			writer.write(payload)
		}
		let flushed = writer.flush()
		await settle()

		let acks: Array<{ seqNo: bigint }> = []
		for (let i = 0; i < CHUNK; i++) {
			acks.push({ seqNo: nextSeqNo++ })
		}
		stream.respond(writeResponse(acks))
		await flushed // resolves only once the window has fully drained

		// Drop the frames the fake harness retains — that is test-side memory, not
		// the writer's, and would otherwise masquerade as a leak.
		stream.sent.length = 0
	}

	// Warm up so steady-state allocations don't count toward the delta.
	for (let c = 0; c < 3; c++) {
		// oxlint-disable-next-line no-await-in-loop
		await driveChunk()
	}
	globalThis.gc?.()
	let before = process.memoryUsage().heapUsed

	// ~1M messages through the one long-lived writer.
	for (let c = 0; c < 100; c++) {
		// oxlint-disable-next-line no-await-in-loop
		await driveChunk()
	}
	globalThis.gc?.()
	let after = process.memoryUsage().heapUsed

	// A per-message retention of even 50 bytes over 1M messages would be ~50 MB.
	// A healthy steady state stays flat (observed: heap actually drops a little).
	expect(after - before).toBeLessThan(16 * 1024 * 1024)
})

test('bounds shared metadata snapshots while writes wait for initialization', () => {
	let { driver } = makeFakeTopicDriver()
	using writer = createTopicWriter(driver, {
		topic: '/t',
		producer: 'p',
		maxBufferBytes: 16n,
		maxInflightCount: 1,
	})
	let payload = bytes(1, 2)
	let metadataItems = { tag: bytes(3, 4, 5) }
	writer.write(payload, { metadataItems })
	writer.write(payload, { metadataItems })

	using copies = vi.spyOn(globalThis, 'Uint8Array')
	expect(() => writer.write(payload, { metadataItems })).toThrow(/buffer is full/)
	expect(copies).not.toHaveBeenCalled()
})

test('snapshots metadata and avoids retaining a larger backing buffer', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })
	let backing = new Uint8Array(1024 * 1024)
	let payload = backing.subarray(0, 3)
	let metadataItems = { trace: bytes(7) }
	writer.write(payload, { metadataItems })
	metadataItems.trace[0] = 9
	metadataItems.trace = new Uint8Array(1024)
	let stream = await waitForNextStream()
	stream.respond(initResponse(0n))
	let request = await stream.waitForWrite()
	let message = request.messages[0]!
	expect(message.data.buffer.byteLength).toBe(3)
	expect(message.metadataItems).toMatchObject([{ key: 'trace', value: bytes(7) }])
})

test('borrows a whole RAW buffer and permits reuse after acknowledgment', async (tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })
	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(0n))

	let payload = bytes(1, 2, 3)
	writer.write(payload)
	let flushed = writer.flush(tc.signal)
	let first = await stream.waitForWrite()
	expect(first.messages[0]!.data).toBe(payload)
	stream.respond(writeResponse([{ seqNo: 1n }]))
	await flushed

	payload.fill(4)
	writer.write(payload)
	let reused = writer.flush(tc.signal)
	await settle()
	let requests = stream.sent.flatMap((frame) =>
		frame.clientMessage.case === 'writeRequest' ? frame.clientMessage.value.messages : []
	)
	let reusedMessage = requests[1]!
	let reusedPayload = [...reusedMessage.data]
	expect(reusedMessage.seqNo).toBe(2n)
	expect(reusedPayload).toEqual([4, 4, 4])

	stream.respond(writeResponse([{ seqNo: 2n }]))
	await expect(reused).resolves.toBe(2n)
})

// Controlled ACKs keep both writes pending across the same reconnect.
test.for([
	{ name: 'RAW', codec: RAW_CODEC },
	{ name: 'GZIP', codec: GZIP_CODEC },
])('resends writes sharing one unchanged input buffer with $name', async ({ codec }, tc) => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p', codec })
	let first = await waitForNextStream()
	await first.waitForInit()
	first.respond(initResponse(0n))

	let payload = bytes(1, 2, 3)
	writer.write(payload)
	writer.write(payload)
	let flushed = writer.flush(tc.signal)
	await first.waitForWrite()
	first.disconnect()

	let replacement = await waitForNextStream()
	await replacement.waitForInit()
	replacement.respond(initResponse(0n))
	let resent = await replacement.waitForWrite()
	expect(resent.messages.map((message) => message.seqNo)).toEqual([1n, 2n])
	expect(resent.messages.map((message) => [...codec.decompress(message.data)])).toEqual([
		[1, 2, 3],
		[1, 2, 3],
	])
	expect([...payload]).toEqual([1, 2, 3])
	expect(resent.messages.every((message) => message.data === payload)).toBe(codec === RAW_CODEC)

	replacement.respond(writeResponse([{ seqNo: 1n }, { seqNo: 2n }]))
	await expect(flushed).resolves.toBe(2n)
})
