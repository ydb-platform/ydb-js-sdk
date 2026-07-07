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
import { type MachineRuntime, createMachineRuntime } from '@ydbjs/fsm'
import { AsyncPriorityQueue } from '@ydbjs/fsm/queue'

import {
	type TransportCtx,
	type TransportEffect,
	type TransportEvent,
	type TransportOutput,
	type TransportState,
	transportTransition,
} from './transport-state.js'
import type { AckStatus, WriteAck } from './types.js'

let dbg = loggers.topic.extend('writer').extend('transport')

// Priorities keep the init handshake ahead of writes and token refreshes ahead
// of the write backlog on the single outgoing stream.
const PRIORITY_INIT = 100
const PRIORITY_TOKEN = 10
const PRIORITY_WRITE = 0

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

// Owns one streamWrite gRPC stream at a time. Reconnecting the underlying stream
// is transparent to the writer FSM: each open pushes a fresh init request and the
// ingest task forwards classified server messages as transport outputs.
export class WriterTransport {
	#driver: Driver
	#params: InitParams
	#updateTokenIntervalMs: number

	#machine: MachineRuntime<TransportState, TransportCtx, TransportEvent, TransportOutput>

	#streamAC: AbortController | null = null
	#streamInput: AsyncPriorityQueue<StreamWriteMessage_FromClient> | null = null
	#streamTask: Promise<void> | null = null
	#getLastSeqNo = true

	constructor(driver: Driver, params: InitParams, updateTokenIntervalMs: number) {
		this.#driver = driver
		this.#params = params
		this.#updateTokenIntervalMs = updateTokenIntervalMs

		this.#machine = createMachineRuntime<
			TransportState,
			TransportCtx,
			{},
			TransportEvent,
			TransportEffect,
			TransportOutput
		>({
			initialState: 'idle',
			ctx: {},
			env: {},
			transition: transportTransition,
			effects: {
				'transport.effect.open_stream': () => {
					this.#openStream()
				},
				'transport.effect.close_stream': async () => {
					await this.#closeStream()
				},
				'transport.effect.finalize': async () => {
					await this.#closeStream()
				},
			},
		})
	}

	get state(): TransportState {
		return this.#machine.state
	}

	// The writer FSM ingests this to receive stream lifecycle events.
	get events(): AsyncIterable<TransportOutput> {
		return this.#machine
	}

	connect(getLastSeqNo: boolean): void {
		this.#getLastSeqNo = getLastSeqNo
		this.#machine.dispatch({ type: 'transport.connect' })
	}

	sendBatch(request: StreamWriteMessage_WriteRequest): void {
		this.#push(
			create(StreamWriteMessage_FromClientSchema, {
				clientMessage: { case: 'writeRequest', value: request },
			}),
			PRIORITY_WRITE
		)
	}

	async sendUpdateToken(): Promise<void> {
		let token = await this.#driver.token
		this.#push(
			create(StreamWriteMessage_FromClientSchema, {
				clientMessage: {
					case: 'updateTokenRequest',
					value: create(UpdateTokenRequestSchema, { token }),
				},
			}),
			PRIORITY_TOKEN
		)
	}

	get updateTokenIntervalMs(): number {
		return this.#updateTokenIntervalMs
	}

	close(): void {
		this.#machine.dispatch({ type: 'transport.close' })
	}

	destroy(reason?: unknown): void {
		this.#machine.dispatch({ type: 'transport.destroy', reason })
	}

	#push(message: StreamWriteMessage_FromClient, priority: number): void {
		let input = this.#streamInput
		if (!input || input.isClosed) {
			return
		}
		input.push(message, priority)
	}

	#openStream(): void {
		void this.#closeStream()

		let ac = new AbortController()
		let input = new AsyncPriorityQueue<StreamWriteMessage_FromClient>()

		input.push(
			create(StreamWriteMessage_FromClientSchema, {
				clientMessage: {
					case: 'initRequest',
					value: create(StreamWriteMessage_InitRequestSchema, {
						path: this.#params.path,
						producerId: this.#params.producerId,
						getLastSeqNo: this.#getLastSeqNo,
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

		let dispatch = this.#machine.dispatch.bind(this.#machine)

		let task = (async () => {
			try {
				await this.#driver.ready(ac.signal)

				let stream = this.#driver
					.createClient(TopicServiceDefinition)
					.streamWrite(input, { signal: ac.signal })

				dbg.log('stream opened (getLastSeqNo=%s)', this.#getLastSeqNo)

				for await (let response of stream) {
					if (ac.signal.aborted) {
						return
					}

					if (response.status !== StatusIds_StatusCode.SUCCESS) {
						dbg.log('recv non-success status %d', response.status)
						dispatch({
							type: 'transport.error',
							error: new YDBError(response.status, response.issues),
						})
						return
					}

					switch (response.serverMessage.case) {
						case 'initResponse': {
							let value = response.serverMessage.value
							dbg.log(
								'recv initResponse (lastSeqNo=%s, sessionId=%s)',
								value.lastSeqNo,
								value.sessionId
							)
							dispatch({
								type: 'transport.init',
								sessionId: value.sessionId,
								lastSeqNo: value.lastSeqNo,
								...(value.partitionId !== undefined && {
									partitionId: value.partitionId,
								}),
							})
							break
						}
						case 'writeResponse': {
							let acks = flattenAcks(response.serverMessage.value)
							dbg.log(
								'recv writeResponse (%d acks: %o)',
								acks.length,
								acks.map((a) => a.seqNo)
							)
							dispatch({ type: 'transport.write', acks })
							break
						}
						case 'updateTokenResponse':
							dbg.log('recv updateTokenResponse')
							dispatch({ type: 'transport.token' })
							break
						default:
							dbg.log('recv unknown server message %s', response.serverMessage.case)
							break
					}
				}

				dbg.log('stream ended')
				dispatch({ type: 'transport.ended' })
			} catch (error) {
				if (ac.signal.aborted) {
					return
				}
				dbg.log('stream error: %O', error)
				dispatch({ type: 'transport.error', error })
			}
		})()

		this.#streamAC = ac
		this.#streamInput = input
		this.#streamTask = task
	}

	async #closeStream(): Promise<void> {
		let ac = this.#streamAC
		let input = this.#streamInput
		let task = this.#streamTask

		this.#streamAC = null
		this.#streamInput = null
		this.#streamTask = null

		if (!ac) {
			return
		}

		ac.abort(new Error('Stream disposed'))
		input?.close()
		await task
	}
}
