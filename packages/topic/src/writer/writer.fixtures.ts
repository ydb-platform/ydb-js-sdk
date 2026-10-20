import { type MessageInitShape, create } from '@bufbuild/protobuf'
import {
	StreamWriteMessage_FromServerSchema,
	StreamWriteMessage_WriteResponse_WriteAckSchema,
} from '@ydbjs/api/topic'
import { AsyncQueue } from '@ydbjs/fsm/queue'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import type {
	StreamWriteMessage_FromClient,
	StreamWriteMessage_FromServer,
	StreamWriteMessage_InitRequest,
	StreamWriteMessage_WriteRequest,
} from '@ydbjs/api/topic'
import type { Driver } from '@ydbjs/core'

import type { AckStatus } from './types.js'

// The fake exposes original objects for allocation/identity tests and exact timer races.
export type FakeWriteStream = {
	respond(message: StreamWriteMessage_FromServer): void
	disconnect(): void
	fail(error: unknown): void
	wasAborted(): boolean
	sent: StreamWriteMessage_FromClient[]
	waitForInit(): Promise<StreamWriteMessage_InitRequest>
	waitForWrite(): Promise<StreamWriteMessage_WriteRequest>
}

export type FakeTopicDriver = {
	driver: Driver
	waitForNextStream(): Promise<FakeWriteStream>
}

export function makeFakeTopicDriver(): FakeTopicDriver {
	let streams = new AsyncQueue<FakeWriteStream>()
	let driver = {
		identity: { database: '/local', address: 'localhost', port: 2136 },
		ready: () => Promise.resolve(),
		get token(): Promise<string> {
			return Promise.resolve('fake-token')
		},
		createClient() {
			return {
				streamWrite(
					input: AsyncIterable<StreamWriteMessage_FromClient>,
					opts?: { signal?: AbortSignal }
				) {
					let responses = new AsyncQueue<StreamWriteMessage_FromServer>()
					let sent: StreamWriteMessage_FromClient[] = []
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
							// Writer cancellation closes its request queue.
						}
					})()

					async function waitForClient<T>(
						pick: (message: StreamWriteMessage_FromClient) => T | undefined
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
						waitForWrite: () =>
							waitForClient((message) =>
								message.clientMessage.case === 'writeRequest'
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
			if (next.done) throw new Error('No writer stream')
			return next.value
		},
	}
}

// ── server message builders ──────────────────────────────────────────────────────

export let initResponse = function initResponse(
	lastSeqNo: bigint,
	sessionId = 'session-1'
): StreamWriteMessage_FromServer {
	return create(StreamWriteMessage_FromServerSchema, {
		status: StatusIds_StatusCode.SUCCESS,
		issues: [],
		serverMessage: {
			case: 'initResponse',
			value: { lastSeqNo, sessionId, partitionId: 0n, supportedCodecs: undefined },
		},
	})
}

export let writeResponse = function writeResponse(
	acks: Array<{ seqNo: bigint; status?: AckStatus; offset?: bigint }>
): StreamWriteMessage_FromServer {
	return create(StreamWriteMessage_FromServerSchema, {
		status: StatusIds_StatusCode.SUCCESS,
		issues: [],
		serverMessage: {
			case: 'writeResponse',
			value: {
				partitionId: 0n,
				acks: acks.map(
					(
						ack
					): MessageInitShape<
						typeof StreamWriteMessage_WriteResponse_WriteAckSchema
					> => ({
						seqNo: ack.seqNo,
						messageWriteStatus:
							(ack.status ?? 'written') === 'skipped'
								? { case: 'skipped', value: { reason: 0 } }
								: (ack.status ?? 'written') === 'writtenInTx'
									? { case: 'writtenInTx', value: {} }
									: { case: 'written', value: { offset: ack.offset ?? 0n } },
					})
				),
			},
		},
	})
}

export let failureResponse = function failureResponse(
	status: StatusIds_StatusCode
): StreamWriteMessage_FromServer {
	return create(StreamWriteMessage_FromServerSchema, {
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

export let tick = function tick(): Promise<void> {
	let d = Promise.withResolvers<void>()
	setTimeout(d.resolve, 0)
	return d.promise
}

export type WriteStream = {
	requests: AsyncIterator<StreamWriteMessage_FromClient>
	responses: AsyncQueue<StreamWriteMessage_FromServer>
	signal: AbortSignal
}

export function nextRequest(
	requests: AsyncIterator<StreamWriteMessage_FromClient>,
	kind: 'initRequest'
): Promise<StreamWriteMessage_InitRequest>
export function nextRequest(
	requests: AsyncIterator<StreamWriteMessage_FromClient>,
	kind: 'writeRequest'
): Promise<StreamWriteMessage_WriteRequest>
export async function nextRequest(
	requests: AsyncIterator<StreamWriteMessage_FromClient>,
	kind: 'initRequest' | 'writeRequest'
): Promise<StreamWriteMessage_InitRequest | StreamWriteMessage_WriteRequest> {
	for (;;) {
		// oxlint-disable-next-line no-await-in-loop
		let next = await requests.next()
		if (next.done) throw new Error(`Stream ended before ${kind}`)
		let message = next.value.clientMessage
		if (message.case === kind) return message.value
	}
}
