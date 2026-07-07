import { subscribe, unsubscribe } from 'node:diagnostics_channel'

import { Codec } from '@ydbjs/api/topic'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { YDBError } from '@ydbjs/error'
import { expect, test } from 'vitest'

import { GZIP_CODEC } from '../codec.ts'
import {
	failureResponse,
	initResponse,
	makeFakeTopicDriver,
	settle,
	writeResponse,
} from './writer.fixtures.ts'
import { createTopicWriter } from './writer.ts'

let bytes = function bytes(...values: number[]): Uint8Array {
	return new Uint8Array(values)
}

test('assigns auto seqNos at send time and acknowledges a flush', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream = await waitForNextStream()
	let init = await stream.waitForInit()
	expect(init.getLastSeqNo).toBe(true)
	expect(init.producerId).toBe('p')

	stream.respond(initResponse(0n))
	await settle()

	writer.write(bytes(1))
	writer.write(bytes(2))
	await settle()

	// Eager per-write pumping may split these across batches — assert the seqNos
	// were assigned sequentially at send time, in order, across all sent writes.
	let seqNos = stream.sent
		.filter((m) => m.clientMessage.case === 'writeRequest')
		.flatMap((m) =>
			m.clientMessage.case === 'writeRequest'
				? m.clientMessage.value.messages.map((x) => x.seqNo)
				: []
		)
	expect(seqNos).toEqual([1n, 2n])

	let flushed = writer.flush()
	stream.respond(writeResponse([{ seqNo: 1n }, { seqNo: 2n }]))

	await expect(flushed).resolves.toBe(2n)

	await writer.close()
})

test('generates a producer id when none is provided', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let writer = createTopicWriter(driver, { topic: '/t' })

	let stream = await waitForNextStream()
	let init = await stream.waitForInit()
	expect(init.producerId).toMatch(/^producer-/)

	writer.destroy()
})

test('continues auto seqNo from the recovered server high-water mark', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(41n))
	await settle()

	writer.write(bytes(1))
	let request = await stream.waitForWrite()
	expect(request.messages[0]!.seqNo).toBe(42n)

	writer.destroy()
})

test('buffers writes received before the session is initialized', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream = await waitForNextStream()
	await stream.waitForInit()

	// Write before init response arrives — must be buffered, not lost.
	writer.write(bytes(7))

	stream.respond(initResponse(10n))

	let request = await stream.waitForWrite()
	expect(request.messages[0]!.seqNo).toBe(11n)

	writer.destroy()
})

test('resends unacked messages after a transparent reconnect', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let first = await waitForNextStream()
	await first.waitForInit()
	first.respond(initResponse(0n))
	await settle()

	writer.write(bytes(1))
	writer.write(bytes(2))
	await first.waitForWrite()

	// Server persisted only seqNo 1; ack it, then drop the stream.
	first.respond(writeResponse([{ seqNo: 1n }]))
	await settle()
	first.disconnect()

	// A second stream opens for the reconnect and must NOT re-request last_seq_no.
	let second = await waitForNextStream()
	let secondInit = await second.waitForInit()
	expect(secondInit.getLastSeqNo).toBe(false)

	second.respond(initResponse(1n))

	let resent = await second.waitForWrite()
	expect(resent.messages.map((m) => m.seqNo)).toEqual([2n])

	writer.destroy()
})

test('does not fail a pending flush across a retryable reconnect', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let first = await waitForNextStream()
	await first.waitForInit()
	first.respond(initResponse(0n))
	await settle()

	writer.write(bytes(1))
	await first.waitForWrite()

	let flushed = writer.flush()
	let settledEarly = false
	void flushed.then(() => (settledEarly = true)).catch(() => (settledEarly = true))

	first.disconnect()
	await settle()
	expect(settledEarly).toBe(false)

	let second = await waitForNextStream()
	await second.waitForInit()
	second.respond(initResponse(0n))

	let resent = await second.waitForWrite()
	expect(resent.messages[0]!.seqNo).toBe(1n)
	second.respond(writeResponse([{ seqNo: 1n }]))

	await expect(flushed).resolves.toBe(1n)

	writer.destroy()
})

test('fails terminally and rejects the flush on a non-retryable error', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(0n))
	await settle()

	writer.write(bytes(1))
	await stream.waitForWrite()

	let flushed = writer.flush()
	stream.respond(failureResponse(StatusIds_StatusCode.SCHEME_ERROR))

	await expect(flushed).rejects.toBeDefined()
	expect(() => writer.write(bytes(2))).toThrow(/failed|closed/)
})

test('drains buffered messages before a graceful close resolves', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(0n))
	await settle()

	writer.write(bytes(1))
	await stream.waitForWrite()

	let closed = false
	let closing = writer.close().then(() => (closed = true))

	await settle()
	expect(closed).toBe(false)

	stream.respond(writeResponse([{ seqNo: 1n }]))
	await closing
	expect(closed).toBe(true)
})

test('rejects pending flush when destroyed', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(0n))
	await settle()

	writer.write(bytes(1))
	await stream.waitForWrite()

	let flushed = writer.flush()
	writer.destroy(new Error('stopped'))

	await expect(flushed).rejects.toThrow('stopped')
})

test('rejects a manual seqNo after auto mode was chosen', async () => {
	let { driver } = makeFakeTopicDriver()
	let writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	writer.write(bytes(1))
	expect(() => writer.write(bytes(2), { seqNo: 5n })).toThrow(/auto mode/)

	writer.destroy()
})

test('rejects a non-increasing manual seqNo', async () => {
	let { driver } = makeFakeTopicDriver()
	let writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	writer.write(bytes(1), { seqNo: 5n })
	expect(() => writer.write(bytes(2), { seqNo: 5n })).toThrow(/strictly increasing/)

	writer.destroy()
})

test('publishes session and acknowledgment diagnostics events', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()

	let sessions: Array<{ producer: string; lastSeqNo: bigint }> = []
	let acks: Array<{ count: number }> = []
	let onSession = (message: unknown) =>
		sessions.push(message as { producer: string; lastSeqNo: bigint })
	let onAck = (message: unknown) => acks.push(message as { count: number })

	subscribe('ydb:topic.writer.session.started', onSession)
	subscribe('ydb:topic.writer.acknowledged', onAck)

	try {
		let writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

		let stream = await waitForNextStream()
		await stream.waitForInit()
		stream.respond(initResponse(7n))
		await settle()

		writer.write(bytes(1))
		let flushed = writer.flush()
		await stream.waitForWrite()
		stream.respond(writeResponse([{ seqNo: 8n }]))
		await flushed

		expect(sessions).toHaveLength(1)
		expect(sessions[0]).toMatchObject({ producer: 'p', lastSeqNo: 7n })
		expect(acks.reduce((sum, a) => sum + a.count, 0)).toBe(1)

		writer.destroy()
	} finally {
		unsubscribe('ydb:topic.writer.session.started', onSession)
		unsubscribe('ydb:topic.writer.acknowledged', onAck)
	}
})

test('invokes the onAck callback for every acknowledged message', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()

	let acked: Array<[bigint, string]> = []
	let writer = createTopicWriter(driver, {
		topic: '/t',
		producer: 'p',
		onAck: (seqNo, status) => acked.push([seqNo, status]),
	})

	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(0n))
	await settle()

	writer.write(bytes(1))
	writer.write(bytes(2))
	await stream.waitForWrite()
	await settle()
	stream.respond(writeResponse([{ seqNo: 1n, status: 'written' }]))
	stream.respond(writeResponse([{ seqNo: 2n, status: 'skipped' }]))
	await settle()

	expect(acked).toEqual([
		[1n, 'written'],
		[2n, 'skipped'],
	])

	writer.destroy()
})

test('surfaces a non-retryable failure during connect as a terminal error', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream = await waitForNextStream()
	await stream.waitForInit()

	writer.write(bytes(1))
	let flushed = writer.flush()

	// Fail before init ever completes.
	stream.respond(failureResponse(StatusIds_StatusCode.SCHEME_ERROR))

	await expect(flushed).rejects.toBeDefined()
	expect(() => writer.write(bytes(2))).toThrow(/failed|closed/)
})

test('keeps draining a graceful close across a mid-close reconnect', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let first = await waitForNextStream()
	await first.waitForInit()
	first.respond(initResponse(0n))
	await settle()

	writer.write(bytes(1))
	await first.waitForWrite()

	let closed = false
	let closing = writer.close().then(() => (closed = true))

	// Stream drops mid-close before the ack — the writer must reconnect and resend.
	first.disconnect()

	let second = await waitForNextStream()
	await second.waitForInit()
	second.respond(initResponse(0n))

	let resent = await second.waitForWrite()
	expect(resent.messages[0]!.seqNo).toBe(1n)
	second.respond(writeResponse([{ seqNo: 1n }]))

	await closing
	expect(closed).toBe(true)
})

test('publishes a reconnecting diagnostics event on a retryable disconnect', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()

	let reconnects: Array<{ attempt: number }> = []
	let onReconnect = (message: unknown) => reconnects.push(message as { attempt: number })
	subscribe('ydb:topic.writer.reconnecting', onReconnect)

	try {
		let writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

		let first = await waitForNextStream()
		await first.waitForInit()
		first.respond(initResponse(0n))
		await settle()

		first.disconnect()

		let second = await waitForNextStream()
		await second.waitForInit()
		second.respond(initResponse(0n))
		await settle()

		expect(reconnects.length).toBeGreaterThanOrEqual(1)

		writer.destroy()
	} finally {
		unsubscribe('ydb:topic.writer.reconnecting', onReconnect)
	}
})

test('closes gracefully via async disposal', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(0n))
	await settle()

	writer.write(bytes(1))
	await stream.waitForWrite()

	let disposing = writer[Symbol.asyncDispose]()
	stream.respond(writeResponse([{ seqNo: 1n }]))
	await disposing
	await settle()

	expect(stream.wasAborted()).toBe(true)
	expect(() => writer.write(bytes(2))).toThrow(/closed/)

	// A second close is a no-op.
	await writer.close()
})

test('tags writes with the transaction identity', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()

	let tx = {
		sessionId: 'tx-session',
		transactionId: 'tx-1',
		onCommit() {},
		onRollback() {},
		onClose() {},
	}

	let writer = createTopicWriter(driver, { topic: '/t', producer: 'p', tx: tx as never })

	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(0n))
	await settle()

	writer.write(bytes(1))
	let request = await stream.waitForWrite()

	expect(request.tx?.id).toBe('tx-1')
	expect(request.tx?.session).toBe('tx-session')

	writer.destroy()
})

test('reconnects after a mid-stream network error', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let first = await waitForNextStream()
	await first.waitForInit()
	first.respond(initResponse(0n))
	await settle()

	writer.write(bytes(1))
	await first.waitForWrite()

	// The gRPC stream throws a retryable transport error mid-flight.
	first.fail(new YDBError(StatusIds_StatusCode.UNAVAILABLE, []))

	let second = await waitForNextStream()
	await second.waitForInit()
	second.respond(initResponse(0n))

	let resent = await second.waitForWrite()
	expect(resent.messages[0]!.seqNo).toBe(1n)

	let flushed = writer.flush()
	second.respond(writeResponse([{ seqNo: 1n }]))
	await expect(flushed).resolves.toBe(1n)

	writer.destroy()
})

// ── resource cleanup ─────────────────────────────────────────────────────────────

test('tears down the underlying stream on destroy', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(0n))
	await settle()

	writer.destroy()
	await settle()

	expect(stream.wasAborted()).toBe(true)
})

test('tears down the underlying stream after a graceful close', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(0n))
	await settle()

	writer.write(bytes(1))
	await stream.waitForWrite()

	let closing = writer.close()
	stream.respond(writeResponse([{ seqNo: 1n }]))
	await closing
	await settle()

	expect(stream.wasAborted()).toBe(true)
})

test('rejects writes and flushes after close, and a second close is a no-op', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(0n))
	await settle()

	await writer.close()

	expect(() => writer.write(bytes(1))).toThrow(/closed/)
	await expect(writer.flush()).rejects.toBeDefined()
	// Idempotent — must not hang or throw.
	await writer.close()
})

// Bring one writer to `ready`, do a write, then destroy it. Returns nothing so
// the writer/driver/stream locals leave the stack and become collectable.
let spinUpAndDestroy = async function spinUpAndDestroy(): Promise<void> {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })
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
	let writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })
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
	let collected = false
	let registry = new FinalizationRegistry<string>(() => {
		collected = true
	})

	await registerForCollection(registry)

	// `collected` is flipped by the FinalizationRegistry callback, which oxlint's
	// static analysis cannot see.
	// oxlint-disable-next-line no-unmodified-loop-condition
	for (let i = 0; i < 50 && !collected; i++) {
		globalThis.gc?.()
		// oxlint-disable-next-line no-await-in-loop
		await new Promise((resolve) => setTimeout(resolve, 10))
	}

	expect(collected).toBe(true)
})

// ── review fixes ─────────────────────────────────────────────────────────────────

test('compresses the payload with a non-RAW codec and reports the uncompressed size', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let writer = createTopicWriter(driver, { topic: '/t', producer: 'p', codec: GZIP_CODEC })

	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(0n))
	await settle()

	let raw = new Uint8Array(1000).fill(65)
	writer.write(raw)

	let request = await stream.waitForWrite()
	expect(request.codec).toBe(Codec.GZIP)
	let message = request.messages[0]!
	// Compressed on the wire, but the server is told the true uncompressed size.
	expect(message.data.length).toBeLessThan(raw.length)
	expect(message.uncompressedSize).toBe(1000n)

	writer.destroy()
})

test('throws on write() issued during a graceful close', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(0n))
	await settle()

	writer.write(bytes(1))
	await stream.waitForWrite()

	let closing = writer.close()
	// close() flips #closing synchronously — a racing write must throw, not vanish.
	expect(() => writer.write(bytes(2))).toThrow(/closed/)

	stream.respond(writeResponse([{ seqNo: 1n }]))
	await closing
})

test('rejects close() when the drain fails terminally (no silent data loss)', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(0n))
	await settle()

	writer.write(bytes(1))
	await stream.waitForWrite()

	let closing = writer.close()
	// A non-retryable failure while draining must surface, not resolve close().
	stream.respond(failureResponse(StatusIds_StatusCode.SCHEME_ERROR))

	await expect(closing).rejects.toBeDefined()
})

test('rejects mixing partitionId and messageGroupId', async () => {
	let { driver } = makeFakeTopicDriver()
	expect(() =>
		createTopicWriter(driver, {
			topic: '/t',
			producer: 'p',
			partitionId: 0n,
			messageGroupId: 'g',
		})
	).toThrow(/mutually exclusive/)
})

test('resends unacked manual-seqNo messages after a reconnect', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let first = await waitForNextStream()
	await first.waitForInit()
	first.respond(initResponse(0n))
	await settle()

	writer.write(bytes(1), { seqNo: 10n })
	writer.write(bytes(2), { seqNo: 20n })
	await first.waitForWrite()

	// Server persisted seqNo 10 only; drop the stream before the rest is acked.
	first.respond(writeResponse([{ seqNo: 10n }]))
	await settle()
	first.disconnect()

	let second = await waitForNextStream()
	await second.waitForInit()
	second.respond(initResponse(10n))

	// seqNo 20 must be resent verbatim (manual seqNos are never renumbered).
	let resent = await second.waitForWrite()
	expect(resent.messages.map((m) => m.seqNo)).toEqual([20n])

	writer.destroy()
})
