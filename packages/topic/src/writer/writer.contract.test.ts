import { subscribe, tracingChannel, unsubscribe } from 'node:diagnostics_channel'
import { getEventListeners } from 'node:events'

import { Codec } from '@ydbjs/api/topic'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { YDBError } from '@ydbjs/error'
import { expect, test } from 'vitest'

import { GZIP_CODEC } from '../codec.ts'
import type { TX } from '../tx.ts'
import {
	failureResponse,
	initResponse,
	makeFakeTopicDriver,
	settle,
	writeResponse,
} from './writer.fixtures.ts'
import { createTopicTxWriter, createTopicWriter } from './writer.ts'

let bytes = function bytes(...values: number[]): Uint8Array {
	return new Uint8Array(values)
}

// A fake transaction that captures the lifecycle hooks the writer registers (it
// registers exactly one of each), so a test can fire commit / rollback / close and
// observe how the writer reacts.
let makeFakeTx = function makeFakeTx() {
	let onCommit: ((signal?: AbortSignal) => Promise<void> | void) | undefined
	let onRollback: ((error: unknown, signal?: AbortSignal) => Promise<void> | void) | undefined
	let onClose: ((committed: boolean, signal?: AbortSignal) => Promise<void> | void) | undefined
	let tx = {
		sessionId: 'tx-session',
		transactionId: 'tx-1',
		onCommit: (fn: (signal?: AbortSignal) => Promise<void> | void) => (onCommit = fn),
		onRollback: (fn: (error: unknown, signal?: AbortSignal) => Promise<void> | void) =>
			(onRollback = fn),
		onClose: (fn: (committed: boolean, signal?: AbortSignal) => Promise<void> | void) =>
			(onClose = fn),
	} as unknown as TX
	return {
		tx,
		commit: (signal?: AbortSignal): Promise<void> | void => onCommit?.(signal),
		rollback: (error: unknown): Promise<void> | void => onRollback?.(error),
		close: (committed: boolean): Promise<void> | void => onClose?.(committed),
	}
}

// Subscribe to an event channel and collect its payloads; `using` auto-unsubscribes.
let collect = function collect<T = unknown>(name: string): { payloads: T[] } & Disposable {
	let payloads: T[] = []
	let fn = (message: unknown) => payloads.push(message as T)
	subscribe(name, fn)
	return {
		payloads,
		[Symbol.dispose]() {
			unsubscribe(name, fn)
		},
	}
}

// Subscribe to a tracing channel and count span phases; `using` auto-unsubscribes.
let collectTrace = function collectTrace(
	name: string
): { counts: { start: number; asyncEnd: number; error: number } } & Disposable {
	let counts = { start: 0, asyncEnd: 0, error: 0 }
	let ch = tracingChannel(name)
	let handlers = {
		start: () => (counts.start += 1),
		asyncEnd: () => (counts.asyncEnd += 1),
		error: () => (counts.error += 1),
	}
	ch.subscribe(handlers)
	return {
		counts,
		[Symbol.dispose]() {
			ch.unsubscribe(handlers)
		},
	}
}

test('assigns auto seqNos at send time and acknowledges a flush', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

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
	using _writer = createTopicWriter(driver, { topic: '/t' })

	let stream = await waitForNextStream()
	let init = await stream.waitForInit()
	expect(init.producerId).toMatch(/^producer-/)
})

test('continues auto seqNo from the recovered server high-water mark', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(41n))
	await settle()

	writer.write(bytes(1))
	let request = await stream.waitForWrite()
	expect(request.messages[0]!.seqNo).toBe(42n)
})

test('buffers writes received before the session is initialized', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream = await waitForNextStream()
	await stream.waitForInit()

	// Write before init response arrives — must be buffered, not lost.
	writer.write(bytes(7))

	stream.respond(initResponse(10n))

	let request = await stream.waitForWrite()
	expect(request.messages[0]!.seqNo).toBe(11n)
})

test('resends unacked messages after a transparent reconnect', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

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
})

test('does not fail a pending flush across a retryable reconnect', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

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
})

test('resolves a pending flush when a reconnect deduplicates all inflight messages', async () => {
	// Real reconnect path. YDB reports the persisted last_seq_no on init even when
	// get_last_seq_no is false (tests/writer-protocol.test.ts), so the reconnect's
	// init here reports 2, deduplicating both inflight messages ('skipped') and
	// draining the window with NO write_response. The flush must still resolve from
	// the init path — otherwise it (and any tx commit awaiting it) hangs forever.
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let first = await waitForNextStream()
	await first.waitForInit()
	first.respond(initResponse(0n))
	await settle()

	writer.write(bytes(1))
	writer.write(bytes(2))
	await first.waitForWrite()

	let flushed = writer.flush()
	first.disconnect()

	let second = await waitForNextStream()
	await second.waitForInit()
	second.respond(initResponse(2n))

	await expect(flushed).resolves.toBe(2n)
})

test('rejects a non-positive maxInflightCount', async () => {
	let { driver } = makeFakeTopicDriver()
	expect(() =>
		createTopicWriter(driver, { topic: '/t', producer: 'p', maxInflightCount: 0 })
	).toThrow(/maxInflightCount/)
})

test('rejects a non-positive maxBufferBytes', async () => {
	let { driver } = makeFakeTopicDriver()
	expect(() =>
		createTopicWriter(driver, { topic: '/t', producer: 'p', maxBufferBytes: 0n })
	).toThrow(/maxBufferBytes/)
})

test('fails terminally and rejects the flush on a non-retryable error', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

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
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

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
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

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
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	writer.write(bytes(1))
	expect(() => writer.write(bytes(2), { seqNo: 5n })).toThrow(/auto mode/)
})

test('rejects a non-increasing manual seqNo', async () => {
	let { driver } = makeFakeTopicDriver()
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	writer.write(bytes(1), { seqNo: 5n })
	expect(() => writer.write(bytes(2), { seqNo: 5n })).toThrow(/strictly increasing/)
})

test('throws synchronously when a write would exceed maxBufferBytes', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p', maxBufferBytes: 4n })

	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(0n))
	await settle()

	writer.write(bytes(1, 2, 3)) // 3 bytes buffered, under the 4-byte cap
	// +2 would total 5 > 4 — a full buffer must throw, not silently drop the write.
	expect(() => writer.write(bytes(4, 5))).toThrow(/buffer is full/i)
})

test('reclaims buffer budget once acknowledgments free bytes', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p', maxBufferBytes: 3n })

	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(0n))
	await settle()

	writer.write(bytes(1, 2, 3)) // fills the 3-byte cap exactly
	expect(() => writer.write(bytes(4))).toThrow(/buffer is full/i)

	await stream.waitForWrite()
	stream.respond(writeResponse([{ seqNo: 1n }])) // ack frees the 3 buffered bytes
	await settle()

	// Budget reclaimed — the next write fits again.
	expect(() => writer.write(bytes(4, 5, 6))).not.toThrow()
})

test('publishes opened, session, and acknowledgment diagnostics events', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()

	type Opened = { producer: string; config: { maxInflightCount: number; maxBufferBytes: bigint } }
	type Ack = { written: number; skipped: number; writtenInTx: number; bytes: bigint }
	using opened = collect<Opened>('ydb:topic.writer.opened')
	using sessions = collect<{ producer: string; lastSeqNo: bigint }>(
		'ydb:topic.writer.session.started'
	)
	using acks = collect<Ack>('ydb:topic.writer.acknowledged')

	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p', maxInflightCount: 7 })

	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(7n))
	await settle()

	writer.write(bytes(1))
	let flushed = writer.flush()
	await stream.waitForWrite()
	stream.respond(writeResponse([{ seqNo: 8n }]))
	await flushed

	// opened: once, carrying the effective config snapshot.
	expect(opened.payloads).toHaveLength(1)
	expect(opened.payloads[0]).toMatchObject({ producer: 'p', config: { maxInflightCount: 7 } })
	expect(opened.payloads[0]!.config.maxBufferBytes).toBeGreaterThan(0n)

	expect(sessions.payloads).toHaveLength(1)
	expect(sessions.payloads[0]).toMatchObject({ producer: 'p', lastSeqNo: 7n })

	// acknowledged: per-status breakdown + acked bytes, not just a total count.
	expect(acks.payloads.reduce((sum, a) => sum + a.written, 0)).toBe(1)
	expect(acks.payloads.reduce((sum, a) => sum + a.bytes, 0n)).toBeGreaterThan(0n)
})

test('emits a flush tracing span', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()

	using flush = collectTrace('tracing:ydb:topic.writer.flush')
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(0n))
	await settle()

	writer.write(bytes(1))
	let flushed = writer.flush()
	await stream.waitForWrite()
	stream.respond(writeResponse([{ seqNo: 1n }]))
	await flushed

	// One flush() → one span (start + resolution).
	expect(flush.counts.start).toBe(1)
	expect(flush.counts.asyncEnd).toBe(1)
})

test('invokes the onAck callback for every acknowledged message', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()

	let acked: Array<[bigint, string]> = []
	using writer = createTopicWriter(driver, {
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
})

test('surfaces a non-retryable failure during connect as a terminal error', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

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
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

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

	using reconnects = collect<{ attempt: number }>('ydb:topic.writer.reconnecting')
	using _writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let first = await waitForNextStream()
	await first.waitForInit()
	first.respond(initResponse(0n))
	await settle()

	first.disconnect()

	let second = await waitForNextStream()
	await second.waitForInit()
	second.respond(initResponse(0n))
	await settle()

	expect(reconnects.payloads.length).toBeGreaterThanOrEqual(1)
})

test('closes gracefully via async disposal', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

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

	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p', tx: tx as never })

	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(0n))
	await settle()

	writer.write(bytes(1))
	let request = await stream.waitForWrite()

	expect(request.tx?.id).toBe('tx-1')
	expect(request.tx?.session).toBe('tx-session')
})

test('reconnects after a mid-stream network error', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

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
})

// ── resource cleanup ─────────────────────────────────────────────────────────────

test('tears down the underlying stream on destroy', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

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
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

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
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

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
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p', codec: GZIP_CODEC })

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
})

test('throws on write() issued during a graceful close', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

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
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

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
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

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
})

// ── transaction lifecycle ──────────────────────────────────────────────────────

test('flushes and closes when the transaction commits', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let fake = makeFakeTx()
	using writer = createTopicTxWriter(fake.tx, driver, { topic: '/t', producer: 'p' })

	let stream = await waitForNextStream()
	let init = await stream.waitForInit()
	expect(init.producerId).toBe('p')
	stream.respond(initResponse(0n))
	await settle()

	writer.write(bytes(1))
	await stream.waitForWrite()

	// Commit runs the onCommit hook, which awaits writer.close() (drains first).
	let committed = fake.commit()
	stream.respond(writeResponse([{ seqNo: 1n }]))
	await committed

	expect(() => writer.write(bytes(2))).toThrow(/closed/)
})

test('destroys the writer when the transaction rolls back', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let fake = makeFakeTx()
	using writer = createTopicTxWriter(fake.tx, driver, { topic: '/t', producer: 'p' })

	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(0n))
	await settle()
	writer.write(bytes(1))

	await fake.rollback(new Error('boom'))
	await settle()

	expect(() => writer.write(bytes(2))).toThrow(/failed|closed/)
	expect(stream.wasAborted()).toBe(true)
})

test('destroys the writer when the transaction closes without commit', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let fake = makeFakeTx()
	using writer = createTopicTxWriter(fake.tx, driver, { topic: '/t', producer: 'p' })

	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(0n))
	await settle()
	writer.write(bytes(1))

	await fake.close(false)
	await settle()

	expect(() => writer.write(bytes(2))).toThrow(/failed|closed/)
})

test('keeps running when the transaction closes after commit', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let fake = makeFakeTx()
	using writer = createTopicTxWriter(fake.tx, driver, { topic: '/t', producer: 'p' })

	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(0n))
	await settle()

	// committed=true → the onClose hook must NOT destroy the writer.
	await fake.close(true)
	await settle()

	expect(() => writer.write(bytes(1))).not.toThrow()
})

// ── user abort signals ─────────────────────────────────────────────────────────

test('rejects a pending flush when the caller aborts the signal', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(0n))
	await settle()

	writer.write(bytes(1))
	await stream.waitForWrite()

	// The message is never acked; aborting the caller's signal must reject flush().
	let ac = new AbortController()
	let flushed = writer.flush(ac.signal)
	ac.abort(new Error('caller cancelled'))

	await expect(flushed).rejects.toThrow('caller cancelled')
})

test('rejects a flush immediately when the signal is already aborted', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(0n))
	await settle()

	writer.write(bytes(1))
	let ac = new AbortController()
	ac.abort(new Error('already gone'))

	await expect(writer.flush(ac.signal)).rejects.toThrow('already gone')
})

test('rejects a close when the caller aborts the signal', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(0n))
	await settle()

	writer.write(bytes(1))
	await stream.waitForWrite()

	// close() blocks draining the unacked message; aborting must reject the close.
	let ac = new AbortController()
	let closing = writer.close(ac.signal)
	ac.abort(new Error('shutdown cancelled'))

	await expect(closing).rejects.toThrow('shutdown cancelled')
})

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

test('ignores destroy after a graceful close', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(0n))
	await settle()

	await writer.close()

	// Already closed → destroy short-circuits, must not throw or re-tear-down.
	expect(() => writer.destroy()).not.toThrow()
	expect(() => writer.destroy(new Error('x'))).not.toThrow()
})

test('rejects writes and flushes after destroy', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(0n))
	await settle()

	writer.destroy(new Error('stopped'))

	expect(() => writer.write(bytes(1))).toThrow(/failed|closed/)
	await expect(writer.flush()).rejects.toBeDefined()
	// A repeat destroy is a no-op.
	expect(() => writer.destroy()).not.toThrow()
})

test('rethrows and destroys on async disposal when the drain fails', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(0n))
	await settle()

	writer.write(bytes(1))
	await stream.waitForWrite()

	// Dispose triggers close(); a fatal drain makes close() reject, so dispose must
	// destroy the writer and rethrow rather than swallow the failure.
	let disposing = writer[Symbol.asyncDispose]()
	stream.respond(failureResponse(StatusIds_StatusCode.SCHEME_ERROR))

	await expect(disposing).rejects.toBeDefined()
	expect(() => writer.write(bytes(2))).toThrow(/failed|closed/)
})

// Bring one writer to `ready`, dispose it gracefully, then drop all locals so it
// becomes collectable — mirrors the destroy-path reclaim test for the close path.
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
	let collected = false
	let registry = new FinalizationRegistry<string>(() => {
		collected = true
	})

	await disposeAndRegister(registry)

	// oxlint-disable-next-line no-unmodified-loop-condition
	for (let i = 0; i < 50 && !collected; i++) {
		globalThis.gc?.()
		// oxlint-disable-next-line no-await-in-loop
		await new Promise((resolve) => setTimeout(resolve, 10))
	}

	expect(collected).toBe(true)
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

test('coalesces update-token requests until one is acknowledged', async () => {
	// The token interval fires on a schedule with no inflight gate. If the stream is
	// open but not draining and we never ack the token, un-coalesced pushes would
	// pile token frames into the stream queue indefinitely (a slow long-lived leak).
	// With coalescing, at most one un-acknowledged token is ever queued.
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using _writer = createTopicWriter(driver, {
		topic: '/t',
		producer: 'p',
		updateTokenIntervalMs: 5, // fire many times quickly
	})

	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(0n))
	await settle()

	// Let the token interval fire many times without ever sending updateTokenResponse.
	await new Promise((resolve) => setTimeout(resolve, 60))

	let tokenFrames = stream.sent.filter((m) => m.clientMessage.case === 'updateTokenRequest')
	expect(tokenFrames).toHaveLength(1)
})
