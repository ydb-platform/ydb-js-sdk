import { create } from '@bufbuild/protobuf'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import {
	type StreamWriteMessage_FromClient,
	StreamWriteMessage_FromClientSchema,
	StreamWriteMessage_InitRequestSchema,
	type StreamWriteMessage_WriteRequest,
	type StreamWriteMessage_WriteResponse,
	TopicServiceDefinition,
	UpdateTokenRequestSchema,
} from '@ydbjs/api/topic'
import type { Driver } from '@ydbjs/core'
import { loggers } from '@ydbjs/debug'
import { YDBError } from '@ydbjs/error'
import { AsyncPriorityQueue, AsyncQueue } from '@ydbjs/fsm/queue'

import type { AckStatus, WriteAck } from './types.js'

let dbg = loggers.topic.extend('writer').extend('transport')

// Priorities keep the init handshake ahead of writes and token refreshes ahead
// of the write backlog on the single outgoing stream.
let PRIORITY_INIT = 100
let PRIORITY_TOKEN = 10
let PRIORITY_WRITE = 0

export type InitParams = {
	path: string
	producerId: string
	partitionId?: bigint
	messageGroupId?: string
}

let flattenAcks = function flattenAcks(response: StreamWriteMessage_WriteResponse): WriteAck[] {
	return response.acks.map((ack) => {
		let status: AckStatus =
			ack.messageWriteStatus.case === 'writtenInTx'
				? 'writtenInTx'
				: ack.messageWriteStatus.case === 'written'
					? 'written'
					: 'skipped'

		if (ack.messageWriteStatus.case === 'written') {
			return { seqNo: ack.seqNo, status, offset: ack.messageWriteStatus.value.offset }
		}

		return { seqNo: ack.seqNo, status }
	})
}

export type TransportOutput =
	| {
			type: 'transport.stream.init_response'
			sessionId: string
			lastSeqNo: bigint
			partitionId?: bigint
			supportedCodecs?: number[]
	  }
	| { type: 'transport.stream.write_response'; acks: WriteAck[] }
	| { type: 'transport.stream.token_response' }
	| { type: 'transport.stream.disconnected'; error?: unknown }

// Owns one streamWrite gRPC stream at a time. Reconnecting the underlying stream
// is transparent to the writer FSM: each open pushes a fresh init request and the
// ingest task forwards classified server messages as transport outputs.
export class WriterTransport {
	#driver: Driver
	#params: InitParams

	#events = new AsyncQueue<TransportOutput>()

	#streamAC: AbortController | null = null
	#streamInput: AsyncPriorityQueue<StreamWriteMessage_FromClient> | null = null
	#tokenPending = false

	constructor(driver: Driver, params: InitParams) {
		this.#driver = driver
		this.#params = params
	}

	// The writer FSM ingests this to receive stream lifecycle events.
	get events(): AsyncIterable<TransportOutput> {
		return this.#events
	}

	connect(getLastSeqNo: boolean): void {
		if (!this.#events.isClosed) this.#openStream(getLastSeqNo)
	}

	sendBatch(request: StreamWriteMessage_WriteRequest): void {
		let input = this.#streamInput
		if (!input) return
		input.push(
			create(StreamWriteMessage_FromClientSchema, {
				clientMessage: { case: 'writeRequest', value: request },
			}),
			PRIORITY_WRITE
		)
	}

	async sendUpdateToken(): Promise<void> {
		let input = this.#streamInput
		if (!input || this.#tokenPending) return
		this.#tokenPending = true
		try {
			let token = await this.#driver.token
			// A refresh belongs to the stream that requested it, even across token-provider awaits.
			if (input !== this.#streamInput) return
			input.push(
				create(StreamWriteMessage_FromClientSchema, {
					clientMessage: {
						case: 'updateTokenRequest',
						value: create(UpdateTokenRequestSchema, { token }),
					},
				}),
				PRIORITY_TOKEN
			)
		} catch (error) {
			if (input === this.#streamInput) this.#tokenPending = false
			throw error
		}
	}

	close(): void {
		this.destroy()
	}

	destroy(reason?: unknown): void {
		this.#closeStream(reason)
		this.#events.destroy()
	}

	#openStream(getLastSeqNo: boolean): void {
		this.#closeStream()

		let ac = new AbortController()
		let input = new AsyncPriorityQueue<StreamWriteMessage_FromClient>()

		input.push(
			create(StreamWriteMessage_FromClientSchema, {
				clientMessage: {
					case: 'initRequest',
					value: create(StreamWriteMessage_InitRequestSchema, {
						path: this.#params.path,
						producerId: this.#params.producerId,
						getLastSeqNo,
						...(this.#params.messageGroupId !== undefined && {
							partitioning: {
								case: 'messageGroupId',
								value: this.#params.messageGroupId,
							},
						}),
						...(this.#params.partitionId !== undefined && {
							partitioning: { case: 'partitionId', value: this.#params.partitionId },
						}),
					}),
				},
			}),
			PRIORITY_INIT
		)

		this.#streamAC = ac
		this.#streamInput = input
		this.#tokenPending = false

		void (async () => {
			try {
				await this.#driver.ready(ac.signal)
				if (ac.signal.aborted) return

				let stream = this.#driver
					.createClient(TopicServiceDefinition)
					.streamWrite(input, { signal: ac.signal })

				dbg.log('stream opened (getLastSeqNo=%s)', getLastSeqNo)

				for await (let response of stream) {
					if (ac.signal.aborted) {
						return
					}

					if (response.status !== StatusIds_StatusCode.SUCCESS) {
						dbg.log('recv non-success status %d', response.status)
						throw new YDBError(response.status, response.issues)
					}

					switch (response.serverMessage.case) {
						case 'initResponse': {
							let value = response.serverMessage.value
							dbg.log(
								'recv initResponse (lastSeqNo=%s, sessionId=%s)',
								value.lastSeqNo,
								value.sessionId
							)
							this.#events.push({
								type: 'transport.stream.init_response',
								sessionId: value.sessionId,
								lastSeqNo: value.lastSeqNo,
								...(value.partitionId !== undefined && {
									partitionId: value.partitionId,
								}),
								...(value.supportedCodecs && {
									supportedCodecs: value.supportedCodecs.codecs,
								}),
							})
							break
						}
						case 'writeResponse': {
							let acks = flattenAcks(response.serverMessage.value)
							// Guard the seqNo array allocation — this is the per-batch hot path.
							if (dbg.enabled) {
								dbg.log(
									'recv writeResponse (%d acks: %o)',
									acks.length,
									acks.map((a) => a.seqNo)
								)
							}
							this.#events.push({ type: 'transport.stream.write_response', acks })
							break
						}
						case 'updateTokenResponse':
							dbg.log('recv updateTokenResponse')
							this.#tokenPending = false
							this.#events.push({ type: 'transport.stream.token_response' })
							break
						default:
							dbg.log('recv unknown server message %s', response.serverMessage.case)
							break
					}
				}

				dbg.log('stream ended')
				if (!ac.signal.aborted) this.#disconnect()
			} catch (error) {
				if (ac.signal.aborted) {
					return
				}
				dbg.log('stream error: %O', error)
				this.#disconnect(error)
			}
		})()
	}

	#disconnect(error?: unknown): void {
		this.#closeStream()
		this.#events.push({
			type: 'transport.stream.disconnected',
			...(error !== undefined && { error }),
		})
	}

	#closeStream(reason?: unknown): void {
		let ac = this.#streamAC
		let input = this.#streamInput
		this.#streamAC = null
		this.#streamInput = null
		ac?.abort(reason ?? new Error('Stream disposed'))
		input?.destroy()
	}
}
