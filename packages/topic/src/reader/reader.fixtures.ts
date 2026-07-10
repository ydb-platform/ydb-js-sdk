import { Codec } from '@ydbjs/api/topic'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import type {
	StreamReadMessage_CommitOffsetRequest,
	StreamReadMessage_FromClient,
	StreamReadMessage_FromServer,
	StreamReadMessage_InitRequest,
	StreamReadMessage_ReadRequest,
	StreamReadMessage_StartPartitionSessionResponse,
} from '@ydbjs/api/topic'
import type { Driver } from '@ydbjs/core'

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
}

export type FakeTopicDriver = {
	driver: Driver
	waitForNextStream(): Promise<FakeReadStream>
	// Number of streamRead streams opened so far (one per connect / reconnect).
	streamCount(): number
}

let deferred = function deferred<T>(): PromiseWithResolvers<T> {
	return Promise.withResolvers<T>()
}

export let makeFakeTopicDriver = function makeFakeTopicDriver(): FakeTopicDriver {
	let pendingHandles: FakeReadStream[] = []
	let pendingWaiters: Array<(handle: FakeReadStream) => void> = []
	let opened = 0

	let waitForNextStream = function waitForNextStream(): Promise<FakeReadStream> {
		if (pendingHandles.length > 0) {
			return Promise.resolve(pendingHandles.shift()!)
		}
		let d = deferred<FakeReadStream>()
		pendingWaiters.push(d.resolve)
		return d.promise
	}

	let deliver = function deliver(handle: FakeReadStream): void {
		if (pendingWaiters.length > 0) {
			pendingWaiters.shift()!(handle)
		} else {
			pendingHandles.push(handle)
		}
	}

	let driver = {
		identity: { database: '/local', address: 'localhost', port: 2136 },
		ready: () => Promise.resolve(),
		get token(): Promise<string> {
			return Promise.resolve('fake-token')
		},
		createClient(): unknown {
			return {
				streamRead(
					input: AsyncIterable<StreamReadMessage_FromClient>,
					opts?: { signal?: AbortSignal }
				): AsyncIterable<StreamReadMessage_FromServer> {
					opened++
					let signal = opts?.signal
					let readers: Array<
						PromiseWithResolvers<IteratorResult<StreamReadMessage_FromServer>>
					> = []
					let queue: StreamReadMessage_FromServer[] = []
					let done = false

					let sent: StreamReadMessage_FromClient[] = []
					let sentWaiters: Array<() => void> = []

					let finish = function finish(): void {
						done = true
						for (let reader of readers.splice(0)) {
							reader.resolve({ value: undefined as never, done: true })
						}
					}

					let aborted = false
					if (signal) {
						if (signal.aborted) {
							done = true
							aborted = true
						} else {
							signal.addEventListener(
								'abort',
								() => {
									aborted = true
									finish()
								},
								{ once: true }
							)
						}
					}

					// Drain what the reader sends so tests can assert on it.
					void (async () => {
						try {
							for await (let message of input) {
								sent.push(message)
								for (let w of sentWaiters.splice(0)) {
									w()
								}
							}
						} catch {
							// input closed — nothing to do
						}
					})()

					let waitForClient = async function waitForClient<T>(
						pick: (m: StreamReadMessage_FromClient) => T | undefined
					): Promise<T> {
						for (;;) {
							for (let message of sent) {
								let picked = pick(message)
								if (picked !== undefined) {
									return picked
								}
							}
							let d = deferred<void>()
							sentWaiters.push(d.resolve)
							// oxlint-disable-next-line no-await-in-loop
							await d.promise
						}
					}

					let handle: FakeReadStream = {
						respond(message) {
							if (done) return
							if (readers.length > 0) {
								readers.shift()!.resolve({ value: message, done: false })
							} else {
								queue.push(message)
							}
						},
						disconnect() {
							finish()
						},
						fail(error) {
							if (done) return
							done = true
							for (let reader of readers.splice(0)) {
								reader.reject(error)
							}
						},
						wasAborted() {
							return aborted
						},
						sent,
						waitForInit() {
							return waitForClient((m) =>
								m.clientMessage.case === 'initRequest'
									? m.clientMessage.value
									: undefined
							)
						},
						waitForReadRequest() {
							return waitForClient((m) =>
								m.clientMessage.case === 'readRequest'
									? m.clientMessage.value
									: undefined
							)
						},
						waitForCommit() {
							return waitForClient((m) =>
								m.clientMessage.case === 'commitOffsetRequest'
									? m.clientMessage.value
									: undefined
							)
						},
						waitForStartResponse() {
							return waitForClient((m) =>
								m.clientMessage.case === 'startPartitionSessionResponse'
									? m.clientMessage.value
									: undefined
							)
						},
					}

					deliver(handle)

					return {
						[Symbol.asyncIterator]() {
							return {
								next(): Promise<IteratorResult<StreamReadMessage_FromServer>> {
									if (queue.length > 0) {
										return Promise.resolve({
											value: queue.shift()!,
											done: false,
										})
									}
									if (done) {
										return Promise.resolve({
											value: undefined as never,
											done: true,
										})
									}
									let d = deferred<IteratorResult<StreamReadMessage_FromServer>>()
									readers.push(d)
									return d.promise
								},
							}
						},
					}
				},
			}
		},
	} as unknown as Driver

	return { driver, waitForNextStream, streamCount: () => opened }
}

// ── server message builders ──────────────────────────────────────────────────────

export let initResponse = function initResponse(
	sessionId = 'session-1'
): StreamReadMessage_FromServer {
	return {
		status: StatusIds_StatusCode.SUCCESS,
		issues: [],
		serverMessage: { case: 'initResponse', value: { sessionId } },
	} as unknown as StreamReadMessage_FromServer
}

export let startPartitionSession = function startPartitionSession(params: {
	partitionSessionId: bigint
	partitionId: bigint
	path?: string
	committedOffset?: bigint
	start?: bigint
	end?: bigint
}): StreamReadMessage_FromServer {
	return {
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
	} as unknown as StreamReadMessage_FromServer
}

// A one-batch ReadResponse for a single partition session. `data` defaults to the
// raw (uncompressed) payload; codec is RAW so the reader decodes it as identity.
export let readResponse = function readResponse(params: {
	partitionSessionId: bigint
	messages: Array<{ offset: bigint; seqNo: bigint; data: Uint8Array }>
	bytesSize?: bigint
	producerId?: string
}): StreamReadMessage_FromServer {
	let bytesSize =
		params.bytesSize ?? params.messages.reduce((acc, m) => acc + BigInt(m.data.length), 0n)
	return {
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
								codec: Codec.RAW,
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
	} as unknown as StreamReadMessage_FromServer
}

export let commitOffsetResponse = function commitOffsetResponse(
	committed: Array<{ partitionSessionId: bigint; committedOffset: bigint }>
): StreamReadMessage_FromServer {
	return {
		status: StatusIds_StatusCode.SUCCESS,
		issues: [],
		serverMessage: {
			case: 'commitOffsetResponse',
			value: { partitionsCommittedOffsets: committed },
		},
	} as unknown as StreamReadMessage_FromServer
}

export let stopPartitionSession = function stopPartitionSession(params: {
	partitionSessionId: bigint
	graceful?: boolean
	committedOffset?: bigint
}): StreamReadMessage_FromServer {
	return {
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
	} as unknown as StreamReadMessage_FromServer
}

export let failureResponse = function failureResponse(
	status: StatusIds_StatusCode
): StreamReadMessage_FromServer {
	return {
		status,
		issues: [],
		serverMessage: { case: undefined, value: undefined },
	} as unknown as StreamReadMessage_FromServer
}

// ── async helpers ──────────────────────────────────────────────────────────────

export let settle = async function settle(ticks = 100): Promise<void> {
	for (let i = 0; i < ticks; i++) {
		// oxlint-disable-next-line no-await-in-loop
		await Promise.resolve()
	}
}
