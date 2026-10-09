import { create } from '@bufbuild/protobuf'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import {
	type StreamReadMessage_FromClient,
	StreamReadMessage_FromClientSchema,
	type StreamReadMessage_FromServer,
	StreamReadMessage_InitRequestSchema,
	type StreamReadMessage_InitRequest_TopicReadSettings,
	TopicServiceDefinition,
	UpdateTokenRequestSchema,
} from '@ydbjs/api/topic'
import type { Driver } from '@ydbjs/core'
import { loggers } from '@ydbjs/debug'
import { YDBError } from '@ydbjs/error'
import { AsyncPriorityQueue, AsyncQueue } from '@ydbjs/fsm/queue'

let dbg = loggers.topic.extend('reader').extend('transport')

// Priorities keep the init handshake ahead of everything and token refreshes
// ahead of the read/commit backlog on the single outgoing stream.
let PRIORITY_INIT = 100
let PRIORITY_TOKEN = 10
let PRIORITY_DEFAULT = 0
// Partition-session control frames (start/stop responses) must overtake queued
// data-plane frames (commits at PRIORITY_DEFAULT): a reconciled commit may never
// reach the wire before the start response that makes its session live.
export const PRIORITY_CONTROL = 10

export type InitParams = {
	consumer: string
	topicsReadSettings: StreamReadMessage_InitRequest_TopicReadSettings[]
	readerName?: string
	autoPartitioningSupport?: boolean
}

export type TransportOutput =
	| { type: 'transport.stream.init_response'; sessionId: string }
	| { type: 'transport.stream.message'; message: StreamReadMessage_FromServer }
	| { type: 'transport.stream.disconnected'; error?: unknown }

// Owns one streamRead gRPC stream at a time. Reconnecting the underlying stream
// is transparent to the reader FSM: each open pushes a fresh init request and the
// ingest task forwards server messages (verbatim, except the init handshake) as
// transport outputs.
export class ReaderTransport {
	#driver: Driver
	#params: InitParams

	#events = new AsyncQueue<TransportOutput>()

	#streamAC: AbortController | null = null
	#streamInput: AsyncPriorityQueue<StreamReadMessage_FromClient> | null = null
	#tokenPending = false

	constructor(driver: Driver, params: InitParams) {
		this.#driver = driver
		this.#params = params
	}

	// The reader FSM ingests this to receive stream lifecycle events.
	get events(): AsyncIterable<TransportOutput> {
		return this.#events
	}

	connect(): void {
		if (!this.#events.isClosed) {
			this.#openStream()
		}
	}

	// Enqueue a client message (read request, commit, partition-session response)
	// on the current stream. No-op if the stream is gone — the reader FSM rebuilds
	// its outgoing state on the next init anyway.
	send(message: StreamReadMessage_FromClient, priority: number = PRIORITY_DEFAULT): boolean {
		let input = this.#streamInput
		if (!input) {
			return false
		}

		input.push(message, priority)
		return true
	}

	async sendUpdateToken(): Promise<void> {
		let input = this.#streamInput
		if (!input || this.#tokenPending) {
			return
		}

		this.#tokenPending = true

		try {
			let token = await this.#driver.token

			// A refresh belongs to the stream that requested it, even across token-provider awaits.
			if (input !== this.#streamInput) {
				return
			}

			input.push(
				create(StreamReadMessage_FromClientSchema, {
					clientMessage: {
						case: 'updateTokenRequest',
						value: create(UpdateTokenRequestSchema, { token }),
					},
				}),
				PRIORITY_TOKEN
			)
		} catch (error) {
			if (input === this.#streamInput) {
				this.#tokenPending = false
			}

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

	#openStream(): void {
		this.#closeStream()

		let ac = new AbortController()
		let input = new AsyncPriorityQueue<StreamReadMessage_FromClient>()

		input.push(
			create(StreamReadMessage_FromClientSchema, {
				clientMessage: {
					case: 'initRequest',
					value: create(StreamReadMessage_InitRequestSchema, {
						consumer: this.#params.consumer,
						topicsReadSettings: this.#params.topicsReadSettings,
						readerName: this.#params.readerName ?? '',
						autoPartitioningSupport: this.#params.autoPartitioningSupport ?? false,
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
				if (ac.signal.aborted) {
					return
				}

				let stream = this.#driver
					.createClient(TopicServiceDefinition)
					.streamRead(input, { signal: ac.signal })

				dbg.log('stream opened (consumer=%s)', this.#params.consumer)

				for await (let response of stream) {
					if (ac.signal.aborted) {
						return
					}

					if (response.status !== StatusIds_StatusCode.SUCCESS) {
						dbg.log('recv non-success status %d', response.status)
						throw new YDBError(response.status, response.issues)
					}

					if (response.serverMessage.case === 'initResponse') {
						dbg.log(
							'recv initResponse (sessionId=%s)',
							response.serverMessage.value.sessionId
						)
						this.#events.push({
							type: 'transport.stream.init_response',
							sessionId: response.serverMessage.value.sessionId,
						})
						continue
					}

					if (response.serverMessage.case === 'updateTokenResponse') {
						this.#tokenPending = false
					}

					this.#events.push({ type: 'transport.stream.message', message: response })
				}

				dbg.log('stream ended')
				if (!ac.signal.aborted) {
					this.#disconnect()
				}
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
