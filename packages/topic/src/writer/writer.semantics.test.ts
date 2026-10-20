import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { create } from '@bufbuild/protobuf'
import {
	Codec,
	type StreamWriteMessage_FromServer,
	StreamWriteMessage_FromServerSchema,
	TopicServiceDefinition,
} from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'
import { AsyncQueue } from '@ydbjs/fsm/queue'
import { YDBError } from '@ydbjs/error'
import { Server, Status } from '@ydbjs/grpc'
import { expect, test } from 'vitest'

import { isRetryableTopicError } from '../retry.ts'
import { GZIP_CODEC } from '../codec.ts'
import type { TX } from '../tx.ts'
import {
	type WriteStream,
	failureResponse,
	initResponse,
	nextRequest,
	writeResponse,
} from './writer.fixtures.ts'
import { TopicWriter, createTopicTxWriter, createTopicWriter } from './writer.ts'

let bytes = function bytes(...values: number[]): Uint8Array {
	return new Uint8Array(values)
}

// Like the fixture's initResponse, but with the topic's permitted codec list —
// the input of the writer's codec negotiation.
let initResponseWithCodecs = function initResponseWithCodecs(
	lastSeqNo: bigint,
	codecs: number[]
): StreamWriteMessage_FromServer {
	return create(StreamWriteMessage_FromServerSchema, {
		status: StatusIds_StatusCode.SUCCESS,
		issues: [],
		serverMessage: {
			case: 'initResponse',
			value: {
				lastSeqNo,
				sessionId: 'session-1',
				partitionId: 0n,
				supportedCodecs: { codecs },
			},
		},
	})
}

// A fake transaction capturing the lifecycle hooks the writer registers, so a
// test can fire commit / rollback / close and observe how the writer reacts.
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

// ── error classification table ───────────────────────────────────────────────────
//
// Full class-by-class table over the writer's stream-error classifier: which
// errors trigger a transparent reconnect and which destroy the writer. Topic
// writes are idempotent (server dedup by producerId+seqNo), so conditionally-
// retryable YDB statuses count as retryable here.

let classifierTable: Array<{
	name: string
	error: unknown
	retryOnSchemeError?: boolean
	retryable: boolean
}> = [
	// A clean stream end with no error object is a server-side reconnect request.
	{ name: 'classifies a clean stream end as retryable', error: undefined, retryable: true },
	{
		name: 'classifies UNAVAILABLE as retryable',
		error: new YDBError(StatusIds_StatusCode.UNAVAILABLE, []),
		retryable: true,
	},
	{
		name: 'classifies OVERLOADED as retryable',
		error: new YDBError(StatusIds_StatusCode.OVERLOADED, []),
		retryable: true,
	},
	{
		name: 'classifies BAD_REQUEST as fatal',
		error: new YDBError(StatusIds_StatusCode.BAD_REQUEST, []),
		retryable: false,
	},
	{
		name: 'classifies SCHEME_ERROR as fatal by default',
		error: new YDBError(StatusIds_StatusCode.SCHEME_ERROR, []),
		retryable: false,
	},
	{
		name: 'classifies SCHEME_ERROR as retryable when retryOnSchemeError is set',
		error: new YDBError(StatusIds_StatusCode.SCHEME_ERROR, []),
		retryOnSchemeError: true,
		retryable: true,
	},
	// A deterministic size rejection can only fail again on resend — must be fatal.
	{
		name: 'classifies a payload-too-large RESOURCE_EXHAUSTED as fatal',
		error: Object.assign(
			new Error('Received message larger than max (66060326 vs. 64000000)'),
			{
				code: Status.RESOURCE_EXHAUSTED,
				details: 'Received message larger than max (66060326 vs. 64000000)',
				metadata: {},
			}
		),
		retryable: false,
	},
	// The same gRPC code without a size complaint is genuine throttling — retryable.
	{
		name: 'classifies a generic throttling RESOURCE_EXHAUSTED as retryable',
		error: Object.assign(new Error('Too many pending requests'), {
			code: Status.RESOURCE_EXHAUSTED,
			details: 'Too many pending requests',
			metadata: {},
		}),
		retryable: true,
	},
	{
		name: 'classifies SESSION_EXPIRED as retryable for idempotent writes',
		error: new YDBError(StatusIds_StatusCode.SESSION_EXPIRED, []),
		retryable: true,
	},
	{
		name: 'classifies UNAUTHORIZED as fatal',
		error: new YDBError(StatusIds_StatusCode.UNAUTHORIZED, []),
		retryable: false,
	},
	// A CANCELLED transport error means the stream was interrupted (e.g. the
	// connection pool was refreshed after discovery), not that the operation was
	// cancelled by the caller — the writer must reconnect.
	{
		name: 'classifies a CANCELLED transport error as retryable',
		error: Object.assign(new Error(''), {
			code: Status.CANCELLED,
			details: '',
			metadata: {},
		}),
		retryable: true,
	},

	{
		name: 'retries a server deadline on an idempotent topic stream',
		error: Object.assign(new Error(''), {
			code: Status.DEADLINE_EXCEEDED,
			details: '',
			metadata: {},
		}),
		retryable: true,
	},
	{
		name: 'classifies an UNAVAILABLE transport error as retryable',
		error: Object.assign(new Error(''), {
			code: Status.UNAVAILABLE,
			details: '',
			metadata: {},
		}),
		retryable: true,
	},
]

test.each(classifierTable)('$name', ({ error, retryOnSchemeError, retryable }) => {
	expect(isRetryableTopicError(error, retryOnSchemeError ?? false)).toBe(retryable)
})

// ── public constructor producer id ───────────────────────────────────────────────

// An empty producer_id in the write InitRequest selects the server's
// no-deduplication mode: resent messages are persisted again instead of being
// deduplicated by producerId+seqNo. The writer's reconnect path relies on that
// dedup as its correctness backstop, so the constructor generates a producer id
// when omitted — exactly like the factory.
test('sends a non-empty producer id from the public constructor', async (tc) => {
	let initialized = Promise.withResolvers<string>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(requests) {
			for await (let request of requests) {
				let message = request.clientMessage
				if (message.case === 'initRequest') {
					initialized.resolve(message.value.producerId)
					yield initResponse(0n)
				}
				if (message.case === 'writeRequest') yield writeResponse(message.value.messages)
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = new TopicWriter(driver, { topic: '/t' })
	writer.write(bytes(1))
	await writer.flush(tc.signal)
	let producer = await initialized.promise
	expect(producer).not.toBe('')
})

test('rejects an explicit empty producer id', () => {
	// producer: '' is not a way to opt out of deduplication — it would silently
	// duplicate in-flight messages on every reconnect.
	using driver = new Driver('grpc://127.0.0.1:1/local', { 'ydb.sdk.enable_discovery': false })
	expect(() => new TopicWriter(driver, { topic: '/t', producer: '' })).toThrow(/producer/)
})

test('resends unacked messages under the same generated producer id', async (tc) => {
	// The generated producer id is what makes reconnect resends safe: the second
	// stream must init with the SAME id so the server can deduplicate the resend.
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = new TopicWriter(driver, { topic: '/t' })

	let first: WriteStream = (await streams.take(tc.signal)).value
	let init = await nextRequest(first.requests, 'initRequest')
	expect(init.producerId).not.toBe('')

	first.responses.push(initResponse(0n))

	writer.write(bytes(1))
	await nextRequest(first.requests, 'writeRequest')

	// Drop the stream before the ack — the message is still in flight.
	first.responses.close()

	let second: WriteStream = (await streams.take(tc.signal)).value
	let reinit = await nextRequest(second.requests, 'initRequest')
	expect(reinit.producerId).toBe(init.producerId)
	second.responses.push(initResponse(0n))

	let resent = await nextRequest(second.requests, 'writeRequest')
	expect(resent.messages.map((m) => m.seqNo)).toEqual([1n])
})

// ── mid-stream retryable status frame ────────────────────────────────────────────

test('reconnects and resends after a retryable mid-stream status frame', async (tc) => {
	// The server can reject mid-stream with a status frame (a FromServer message
	// whose status is not SUCCESS) instead of breaking the stream. A retryable
	// status like UNAVAILABLE must behave exactly like a transport error:
	// transparent reconnect, resend of unacked messages, and the flush resolves.
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let first: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(first.requests, 'initRequest')
	first.responses.push(initResponse(0n))

	writer.write(bytes(1))
	writer.write(bytes(2))
	await nextRequest(first.requests, 'writeRequest')

	// The server persists seqNo 1, then sends a non-SUCCESS UNAVAILABLE frame.
	first.responses.push(writeResponse([{ seqNo: 1n }]))

	first.responses.push(failureResponse(StatusIds_StatusCode.UNAVAILABLE))

	let second: WriteStream = (await streams.take(tc.signal)).value
	let secondInit = await nextRequest(second.requests, 'initRequest')
	expect(secondInit.getLastSeqNo).toBe(false)

	second.responses.push(initResponse(1n))

	let resent = await nextRequest(second.requests, 'writeRequest')
	expect(resent.messages.map((m) => m.seqNo)).toEqual([2n])

	let flushed = writer.flush()
	second.responses.push(writeResponse([{ seqNo: 2n }]))
	await expect(flushed).resolves.toBe(2n)
})

// ── transaction identity across reconnect ────────────────────────────────────────

test('keeps the transaction identity on writes resent after a reconnect', async (tc) => {
	// A tx message resent after a reconnect must carry the same tx identity as
	// the original send — a resend without the tx tag would be a plain write:
	// immediately visible and surviving rollback, silently breaking atomicity.
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	let fake = makeFakeTx()
	using writer = createTopicTxWriter(fake.tx, driver, { topic: '/t', producer: 'p' })

	let first: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(first.requests, 'initRequest')
	first.responses.push(initResponse(0n))

	writer.write(bytes(1))
	let original = await nextRequest(first.requests, 'writeRequest')
	expect(original.tx?.id).toBe('tx-1')
	expect(original.tx?.session).toBe('tx-session')

	// Drop the stream before the ack — the tx message is still in flight.
	first.responses.close()

	let second: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(second.requests, 'initRequest')
	second.responses.push(initResponse(0n))

	let resent = await nextRequest(second.requests, 'writeRequest')
	expect(resent.messages.map((m) => m.seqNo)).toEqual([1n])
	expect(resent.tx?.id).toBe('tx-1')
	expect(resent.tx?.session).toBe('tx-session')

	// The drain spans the reconnect: the commit resolves once the resend is acked.
	let committed = fake.commit()
	second.responses.push(writeResponse([{ seqNo: 1n }]))
	await committed

	expect(() => writer.write(bytes(2))).toThrow(/closed/)
})

// ── graceful-drain failure fails the tx commit ───────────────────────────────────

test('rejects the transaction commit when the graceful drain times out', async (tc) => {
	// Commit runs the onCommit hook, which awaits writer.close(). When the drain
	// cannot complete (the server never acks within the graceful timeout), the
	// commit must reject — a commit resolving over undelivered tx writes would
	// silently commit a transaction that lost messages.
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	let fake = makeFakeTx()
	using writer = createTopicTxWriter(fake.tx, driver, {
		topic: '/t',
		producer: 'p',
		gracefulShutdownTimeoutMs: 30,
	})

	let stream: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(stream.requests, 'initRequest')
	stream.responses.push(initResponse(0n))

	writer.write(bytes(1))
	await nextRequest(stream.requests, 'writeRequest')

	// The server never acks; the graceful timeout fires with the message in flight.
	await expect(Promise.resolve(fake.commit())).rejects.toThrow(/undelivered/i)

	// The writer is terminally errored — no further writes are accepted.
	expect(() => writer.write(bytes(2))).toThrow(/failed|closed/)
})

// ── codec negotiation against InitResponse.supported_codecs ──────────────────────

// The server permits only codecs listed in InitResponse.supported_codecs (an empty
// list disables the check); any other codec kills the session with an opaque
// BAD_REQUEST at the first WriteRequest — after data is already buffered. The
// writer must fail at init instead: terminally, with an error naming the codec,
// and with no WriteRequest on the wire.
test('fails terminally when the topic does not allow the configured codec', async (tc) => {
	let streams = new AsyncQueue<WriteStream>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(input, { signal }) {
			using responses = new AsyncQueue<StreamWriteMessage_FromServer>()
			streams.push({ requests: input[Symbol.asyncIterator](), responses, signal })
			signal.addEventListener('abort', () => responses.close(), { once: true })
			yield* responses
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p', codec: GZIP_CODEC })

	writer.write(bytes(1))
	let flush = writer.flush()
	flush.catch(() => {})

	let stream: WriteStream = (await streams.take(tc.signal)).value
	await nextRequest(stream.requests, 'initRequest')
	stream.responses.push(initResponseWithCodecs(0n, [Codec.RAW]))

	await expect(flush).rejects.toThrow(/codec 2 .*supported codecs: 1/i)
	let pendingWrite = nextRequest(stream.requests, 'writeRequest')
	await expect(pendingWrite).rejects.toBeDefined()
	expect(() => writer.write(bytes(2))).toThrow(/failed|closed/)
})

test('writes when the topic allows the configured codec', async (tc) => {
	let received = Promise.withResolvers<number>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(requests) {
			for await (let request of requests) {
				let message = request.clientMessage
				if (message.case === 'initRequest')
					yield initResponseWithCodecs(0n, [Codec.RAW, Codec.GZIP])
				if (message.case === 'writeRequest') {
					received.resolve(message.value.messages.length)
					yield writeResponse(message.value.messages)
				}
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p', codec: GZIP_CODEC })
	writer.write(bytes(1))
	await writer.flush(tc.signal)
	let count = await received.promise
	expect(count).toBe(1)
})

test('skips the codec check when the server sends no supported list', async (tc) => {
	let received = Promise.withResolvers<number>()
	using server = new Server()
	server.add(TopicServiceDefinition, {
		async *streamWrite(requests) {
			for await (let request of requests) {
				let message = request.clientMessage
				if (message.case === 'initRequest') yield initResponse(0n)
				if (message.case === 'writeRequest') {
					received.resolve(message.value.messages.length)
					yield writeResponse(message.value.messages)
				}
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		'ydb.sdk.enable_discovery': false,
	})
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p', codec: GZIP_CODEC })
	writer.write(bytes(1))
	await writer.flush(tc.signal)
	let count = await received.promise
	expect(count).toBe(1)
})
