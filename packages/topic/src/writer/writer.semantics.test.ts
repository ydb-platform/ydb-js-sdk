import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { Codec, type StreamWriteMessage_FromServer } from '@ydbjs/api/topic'
import { YDBError } from '@ydbjs/error'
import { ClientError, Status } from 'nice-grpc'
import { expect, test } from 'vitest'

import { GZIP_CODEC } from '../codec.ts'
import type { TX } from '../tx.ts'
import { isRetryableWriterError } from './writer-state.ts'
import {
	failureResponse,
	initResponse,
	makeFakeTopicDriver,
	settle,
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
	return {
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
	} as unknown as StreamWriteMessage_FromServer
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

let GRPC_PATH = '/Ydb.Topic.V1.TopicService/StreamWrite'

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
		error: new ClientError(
			GRPC_PATH,
			Status.RESOURCE_EXHAUSTED,
			'Received message larger than max (66060326 vs. 64000000)'
		),
		retryable: false,
	},
	// The same gRPC code without a size complaint is genuine throttling — retryable.
	{
		name: 'classifies a generic throttling RESOURCE_EXHAUSTED as retryable',
		error: new ClientError(GRPC_PATH, Status.RESOURCE_EXHAUSTED, 'Too many pending requests'),
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
		error: new ClientError(GRPC_PATH, Status.CANCELLED, ''),
		retryable: true,
	},
	// Divergence from the go SDK: go treats DEADLINE_EXCEEDED on a topic stream as
	// retryable (a proxy/LB deadline blip reconnects), while this classifier is
	// terminal — the writer is destroyed. Pinned as currently implemented.
	{
		name: 'classifies a DEADLINE_EXCEEDED transport error as fatal',
		error: new ClientError(GRPC_PATH, Status.DEADLINE_EXCEEDED, ''),
		retryable: false,
	},
	{
		name: 'classifies an UNAVAILABLE transport error as retryable',
		error: new ClientError(GRPC_PATH, Status.UNAVAILABLE, ''),
		retryable: true,
	},
]

test.each(classifierTable)('$name', ({ error, retryOnSchemeError, retryable }) => {
	expect(isRetryableWriterError(error, retryOnSchemeError ?? false)).toBe(retryable)
})

// ── public constructor producer id ───────────────────────────────────────────────

// An empty producer_id in the write InitRequest selects the server's
// no-deduplication mode: resent messages are persisted again instead of being
// deduplicated by producerId+seqNo. The writer's reconnect path relies on that
// dedup as its correctness backstop, so the constructor generates a producer id
// when omitted — exactly like the factory.
test('sends a non-empty producer id from the public constructor', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using _writer = new TopicWriter(driver, { topic: '/t' })

	let stream = await waitForNextStream()
	let init = await stream.waitForInit()

	expect(init.producerId).not.toBe('')
})

test('rejects an explicit empty producer id', () => {
	// producer: '' is not a way to opt out of deduplication — it would silently
	// duplicate in-flight messages on every reconnect.
	let { driver } = makeFakeTopicDriver()
	expect(() => new TopicWriter(driver, { topic: '/t', producer: '' })).toThrow(/producer/)
})

test('resends unacked messages under the same generated producer id', async () => {
	// The generated producer id is what makes reconnect resends safe: the second
	// stream must init with the SAME id so the server can deduplicate the resend.
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using writer = new TopicWriter(driver, { topic: '/t' })

	let first = await waitForNextStream()
	let init = await first.waitForInit()
	expect(init.producerId).not.toBe('')

	first.respond(initResponse(0n))
	await settle()

	writer.write(bytes(1))
	await first.waitForWrite()

	// Drop the stream before the ack — the message is still in flight.
	first.disconnect()

	let second = await waitForNextStream()
	let reinit = await second.waitForInit()
	expect(reinit.producerId).toBe(init.producerId)
	second.respond(initResponse(0n))

	let resent = await second.waitForWrite()
	expect(resent.messages.map((m) => m.seqNo)).toEqual([1n])
})

// ── mid-stream retryable status frame ────────────────────────────────────────────

test('reconnects and resends after a retryable mid-stream status frame', async () => {
	// The server can reject mid-stream with a status frame (a FromServer message
	// whose status is not SUCCESS) instead of breaking the stream. A retryable
	// status like UNAVAILABLE must behave exactly like a transport error:
	// transparent reconnect, resend of unacked messages, and the flush resolves.
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })

	let first = await waitForNextStream()
	await first.waitForInit()
	first.respond(initResponse(0n))
	await settle()

	writer.write(bytes(1))
	writer.write(bytes(2))
	await first.waitForWrite()

	// The server persists seqNo 1, then sends a non-SUCCESS UNAVAILABLE frame.
	first.respond(writeResponse([{ seqNo: 1n }]))
	await settle()
	first.respond(failureResponse(StatusIds_StatusCode.UNAVAILABLE))

	let second = await waitForNextStream()
	let secondInit = await second.waitForInit()
	expect(secondInit.getLastSeqNo).toBe(false)

	second.respond(initResponse(1n))

	let resent = await second.waitForWrite()
	expect(resent.messages.map((m) => m.seqNo)).toEqual([2n])

	let flushed = writer.flush()
	second.respond(writeResponse([{ seqNo: 2n }]))
	await expect(flushed).resolves.toBe(2n)
})

// ── transaction identity across reconnect ────────────────────────────────────────

test('keeps the transaction identity on writes resent after a reconnect', async () => {
	// A tx message resent after a reconnect must carry the same tx identity as
	// the original send — a resend without the tx tag would be a plain write:
	// immediately visible and surviving rollback, silently breaking atomicity.
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let fake = makeFakeTx()
	using writer = createTopicTxWriter(fake.tx, driver, { topic: '/t', producer: 'p' })

	let first = await waitForNextStream()
	await first.waitForInit()
	first.respond(initResponse(0n))
	await settle()

	writer.write(bytes(1))
	let original = await first.waitForWrite()
	expect(original.tx?.id).toBe('tx-1')
	expect(original.tx?.session).toBe('tx-session')

	// Drop the stream before the ack — the tx message is still in flight.
	first.disconnect()

	let second = await waitForNextStream()
	await second.waitForInit()
	second.respond(initResponse(0n))

	let resent = await second.waitForWrite()
	expect(resent.messages.map((m) => m.seqNo)).toEqual([1n])
	expect(resent.tx?.id).toBe('tx-1')
	expect(resent.tx?.session).toBe('tx-session')

	// The drain spans the reconnect: the commit resolves once the resend is acked.
	let committed = fake.commit()
	second.respond(writeResponse([{ seqNo: 1n }]))
	await committed

	expect(() => writer.write(bytes(2))).toThrow(/closed/)
})

// ── graceful-drain failure fails the tx commit ───────────────────────────────────

test('rejects the transaction commit when the graceful drain times out', async () => {
	// Commit runs the onCommit hook, which awaits writer.close(). When the drain
	// cannot complete (the server never acks within the graceful timeout), the
	// commit must reject — a commit resolving over undelivered tx writes would
	// silently commit a transaction that lost messages.
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let fake = makeFakeTx()
	using writer = createTopicTxWriter(fake.tx, driver, {
		topic: '/t',
		producer: 'p',
		gracefulShutdownTimeoutMs: 30,
	})

	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(0n))
	await settle()

	writer.write(bytes(1))
	await stream.waitForWrite()

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
test('fails terminally when the topic does not allow the configured codec', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p', codec: GZIP_CODEC })

	writer.write(bytes(1))
	let flush = writer.flush()
	flush.catch(() => {})

	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponseWithCodecs(0n, [Codec.RAW]))
	await settle()

	await expect(flush).rejects.toThrow(/codec 2 .*supported codecs: 1/i)
	expect(stream.sent.some((m) => m.clientMessage.case === 'writeRequest')).toBe(false)
	expect(() => writer.write(bytes(2))).toThrow(/failed|closed/)
})

test('writes when the topic allows the configured codec', async () => {
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p', codec: GZIP_CODEC })

	writer.write(bytes(1))
	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponseWithCodecs(0n, [Codec.RAW, Codec.GZIP]))

	let request = await stream.waitForWrite()
	expect(request.messages).toHaveLength(1)
})

test('skips the codec check when the server sends no supported list', async () => {
	// An absent / empty supported_codecs means the server-side codec check is
	// disabled — the writer must not invent a restriction of its own.
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p', codec: GZIP_CODEC })

	writer.write(bytes(1))
	let stream = await waitForNextStream()
	await stream.waitForInit()
	stream.respond(initResponse(0n))

	let request = await stream.waitForWrite()
	expect(request.messages).toHaveLength(1)
})
