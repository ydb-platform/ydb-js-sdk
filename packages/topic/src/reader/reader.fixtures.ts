import { create } from '@bufbuild/protobuf'
import { Codec, StreamReadMessage_FromServerSchema } from '@ydbjs/api/topic'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import type {
	StreamReadMessage_CommitOffsetRequest,
	StreamReadMessage_FromClient,
	StreamReadMessage_FromServer,
	StreamReadMessage_InitRequest,
	StreamReadMessage_ReadRequest,
	StreamReadMessage_StartPartitionSessionResponse,
	UpdateOffsetsInTransactionRequest,
	UpdateTokenRequest,
} from '@ydbjs/api/topic'
import type { Driver } from '@ydbjs/core'
import { AsyncQueue } from '@ydbjs/fsm/queue'

import type { TX } from '../tx.js'

// A handle to one streamRead the reader opened. Lets the test drive the server
// side (respond / disconnect / fail) and inspect what the reader sent (init /
// read requests / commits / start-session acks).
export type FakeReadStream = {
	respond(message: StreamReadMessage_FromServer): void
	disconnect(): void
	fail(error: unknown): void
	// True once the reader aborted this stream's signal (i.e. tore the stream down).
	wasAborted(): boolean
	sent: StreamReadMessage_FromClient[]
	waitForInit(): Promise<StreamReadMessage_InitRequest>
	waitForReadRequest(): Promise<StreamReadMessage_ReadRequest>
	waitForCommit(): Promise<StreamReadMessage_CommitOffsetRequest>
	waitForStartResponse(): Promise<StreamReadMessage_StartPartitionSessionResponse>
	waitForUpdateToken(): Promise<UpdateTokenRequest>
}

export type FakeTopicDriver = {
	driver: Driver
	waitForNextStream(): Promise<FakeReadStream>
	// Number of streamRead streams opened so far (one per connect / reconnect).
	streamCount(): number
	// Every UpdateOffsetsInTransaction request the tx commit hook sent (acked with
	// SUCCESS) — the wire-level observation point for tx read offsets.
	txOffsetRequests: UpdateOffsetsInTransactionRequest[]
}

// A fake transaction that captures the lifecycle hooks the reader registers (it
// registers exactly one of each), so a test can fire commit / rollback / close and
// observe how the reader reacts. Mirrors the writer's fixture of the same name.
export let makeFakeTx = function makeFakeTx() {
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

// These tests control object ownership and client-side scheduling independently of the network.
export function makeFakeTopicDriver(): FakeTopicDriver {
	let streams = new AsyncQueue<FakeReadStream>()
	let opened = 0
	let txOffsetRequests: UpdateOffsetsInTransactionRequest[] = []
	let driver = {
		identity: { database: '/local', address: 'localhost', port: 2136 },
		ready: () => Promise.resolve(),
		get token(): Promise<string> {
			return Promise.resolve('fake-token')
		},
		createClient() {
			return {
				updateOffsetsInTransaction(request: UpdateOffsetsInTransactionRequest) {
					txOffsetRequests.push(request)
					return Promise.resolve({
						operation: {
							ready: true,
							status: StatusIds_StatusCode.SUCCESS,
							issues: [],
						},
					})
				},
				streamRead(
					input: AsyncIterable<StreamReadMessage_FromClient>,
					opts?: { signal?: AbortSignal }
				) {
					opened++
					let responses = new AsyncQueue<StreamReadMessage_FromServer>()
					let sent: StreamReadMessage_FromClient[] = []
					let changed = Promise.withResolvers<void>()
					let signal = opts?.signal
					if (signal?.aborted) responses.close()
					else signal?.addEventListener('abort', () => responses.close(), { once: true })

					void (async () => {
						try {
							for await (let message of input) {
								sent.push(message)
								changed.resolve()
								changed = Promise.withResolvers<void>()
							}
						} catch {
							// Reader cancellation closes its request queue.
						}
					})()

					async function waitForClient<T>(
						pick: (message: StreamReadMessage_FromClient) => T | undefined
					): Promise<T> {
						for (;;) {
							for (let message of sent) {
								let value = pick(message)
								if (value !== undefined) return value
							}
							// oxlint-disable-next-line no-await-in-loop
							await changed.promise
						}
					}

					streams.push({
						respond(message) {
							if (!responses.isClosed) responses.push(message)
						},
						disconnect: () => responses.close(),
						fail: (error) => responses.fail(error),
						wasAborted: () => signal?.aborted ?? false,
						sent,
						waitForInit: () =>
							waitForClient((message) =>
								message.clientMessage.case === 'initRequest'
									? message.clientMessage.value
									: undefined
							),
						waitForReadRequest: () =>
							waitForClient((message) =>
								message.clientMessage.case === 'readRequest'
									? message.clientMessage.value
									: undefined
							),
						waitForCommit: () =>
							waitForClient((message) =>
								message.clientMessage.case === 'commitOffsetRequest'
									? message.clientMessage.value
									: undefined
							),
						waitForStartResponse: () =>
							waitForClient((message) =>
								message.clientMessage.case === 'startPartitionSessionResponse'
									? message.clientMessage.value
									: undefined
							),
						waitForUpdateToken: () =>
							waitForClient((message) =>
								message.clientMessage.case === 'updateTokenRequest'
									? message.clientMessage.value
									: undefined
							),
					})
					return responses
				},
			}
		},
	} as unknown as Driver
	return {
		driver,
		async waitForNextStream() {
			let next = await streams.take()
			if (next.done) throw new Error('No reader stream')
			return next.value
		},
		streamCount: () => opened,
		txOffsetRequests,
	}
}

// ── server message builders ──────────────────────────────────────────────────────

export let initResponse = function initResponse(
	sessionId = 'session-1'
): StreamReadMessage_FromServer {
	return create(StreamReadMessage_FromServerSchema, {
		status: StatusIds_StatusCode.SUCCESS,
		issues: [],
		serverMessage: { case: 'initResponse', value: { sessionId } },
	})
}

export let startPartitionSession = function startPartitionSession(params: {
	partitionSessionId: bigint
	partitionId: bigint
	path?: string
	committedOffset?: bigint
	start?: bigint
	end?: bigint
}): StreamReadMessage_FromServer {
	return create(StreamReadMessage_FromServerSchema, {
		status: StatusIds_StatusCode.SUCCESS,
		issues: [],
		serverMessage: {
			case: 'startPartitionSessionRequest',
			value: {
				partitionSession: {
					partitionSessionId: params.partitionSessionId,
					partitionId: params.partitionId,
					path: params.path ?? '/t',
				},
				committedOffset: params.committedOffset ?? 0n,
				partitionOffsets: { start: params.start ?? 0n, end: params.end ?? 0n },
			},
		},
	})
}

// A one-batch ReadResponse for a single partition session. `data` defaults to the
// raw (uncompressed) payload; codec defaults to RAW so the reader decodes it as
// identity — pass a compressed `data` together with its `codec` otherwise.
export let readResponse = function readResponse(params: {
	partitionSessionId: bigint
	messages: Array<{ offset: bigint; seqNo: bigint; data: Uint8Array }>
	bytesSize?: bigint
	producerId?: string
	codec?: Codec
}): StreamReadMessage_FromServer {
	let bytesSize =
		params.bytesSize ?? params.messages.reduce((acc, m) => acc + BigInt(m.data.length), 0n)
	return create(StreamReadMessage_FromServerSchema, {
		status: StatusIds_StatusCode.SUCCESS,
		issues: [],
		serverMessage: {
			case: 'readResponse',
			value: {
				bytesSize,
				partitionData: [
					{
						partitionSessionId: params.partitionSessionId,
						batches: [
							{
								producerId: params.producerId ?? 'producer-1',
								codec: params.codec ?? Codec.RAW,
								messageData: params.messages.map((m) => ({
									offset: m.offset,
									seqNo: m.seqNo,
									data: m.data,
									uncompressedSize: BigInt(m.data.length),
									metadataItems: [],
								})),
							},
						],
					},
				],
			},
		},
	})
}

export let commitOffsetResponse = function commitOffsetResponse(
	committed: Array<{ partitionSessionId: bigint; committedOffset: bigint }>
): StreamReadMessage_FromServer {
	return create(StreamReadMessage_FromServerSchema, {
		status: StatusIds_StatusCode.SUCCESS,
		issues: [],
		serverMessage: {
			case: 'commitOffsetResponse',
			value: { partitionsCommittedOffsets: committed },
		},
	})
}

export let stopPartitionSession = function stopPartitionSession(params: {
	partitionSessionId: bigint
	graceful?: boolean
	committedOffset?: bigint
}): StreamReadMessage_FromServer {
	return create(StreamReadMessage_FromServerSchema, {
		status: StatusIds_StatusCode.SUCCESS,
		issues: [],
		serverMessage: {
			case: 'stopPartitionSessionRequest',
			value: {
				partitionSessionId: params.partitionSessionId,
				graceful: params.graceful ?? false,
				committedOffset: params.committedOffset ?? 0n,
			},
		},
	})
}

export let updateTokenResponse = function updateTokenResponse(): StreamReadMessage_FromServer {
	return create(StreamReadMessage_FromServerSchema, {
		status: StatusIds_StatusCode.SUCCESS,
		issues: [],
		serverMessage: { case: 'updateTokenResponse', value: {} },
	})
}

export let partitionStatusResponse = function partitionStatusResponse(
	partitionSessionId: bigint,
	committedOffset: bigint
): StreamReadMessage_FromServer {
	return create(StreamReadMessage_FromServerSchema, {
		status: StatusIds_StatusCode.SUCCESS,
		issues: [],
		serverMessage: {
			case: 'partitionSessionStatusResponse',
			value: { partitionSessionId, committedOffset, readOffset: committedOffset },
		},
	})
}

export let failureResponse = function failureResponse(
	status: StatusIds_StatusCode
): StreamReadMessage_FromServer {
	return create(StreamReadMessage_FromServerSchema, {
		status,
		issues: [],
		serverMessage: { case: undefined, value: undefined },
	})
}

// ── async helpers ──────────────────────────────────────────────────────────────

export let settle = async function settle(ticks = 100): Promise<void> {
	for (let i = 0; i < ticks; i++) {
		// oxlint-disable-next-line no-await-in-loop
		await Promise.resolve()
	}
}
