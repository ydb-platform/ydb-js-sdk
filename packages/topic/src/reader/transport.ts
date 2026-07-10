import { create } from '@bufbuild/protobuf'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import {
	type StreamReadMessage_FromClient,
	StreamReadMessage_FromClientSchema,
	StreamReadMessage_InitRequestSchema,
	type StreamReadMessage_InitRequest_TopicReadSettings,
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

let dbg = loggers.topic.extend('reader').extend('transport')

// Priorities keep the init handshake ahead of everything and token refreshes
// ahead of the read/commit backlog on the single outgoing stream.
let PRIORITY_INIT = 100
let PRIORITY_TOKEN = 10
let PRIORITY_DEFAULT = 0

export type InitParams = {
	consumer: string
	topicsReadSettings: StreamReadMessage_InitRequest_TopicReadSettings[]
	readerName?: string
	autoPartitioningSupport?: boolean
}

// Owns one streamRead gRPC stream at a time. Reconnecting the underlying stream
// is transparent to the reader FSM: each open pushes a fresh init request and the
// ingest task forwards server messages (verbatim, except the init handshake) as
// transport outputs.
export class ReaderTransport {
	#driver: Driver
	#params: InitParams

	#machine: MachineRuntime<TransportState, TransportCtx, TransportEvent, TransportOutput>

	#streamAC: AbortController | null = null
	#streamInput: AsyncPriorityQueue<StreamReadMessage_FromClient> | null = null
	#streamTask: Promise<void> | null = null
	#tokenPending = false

	constructor(driver: Driver, params: InitParams) {
		this.#driver = driver
		this.#params = params

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

	// The reader FSM ingests this to receive stream lifecycle events.
	get events(): AsyncIterable<TransportOutput> {
		return this.#machine
	}

	connect(): void {
		this.#machine.dispatch({ type: 'transport.connect' })
	}

	// Enqueue a client message (read request, commit, partition-session response)
	// on the current stream. No-op if the stream is gone — the reader FSM rebuilds
	// its outgoing state on the next init anyway.
	send(message: StreamReadMessage_FromClient, priority: number = PRIORITY_DEFAULT): boolean {
		return this.#push(message, priority)
	}

	async sendUpdateToken(): Promise<void> {
		// Coalesce: keep at most one un-acknowledged update-token queued (see the
		// writer transport for the rationale) — an interval-driven push on a wedged
		// stream would otherwise pile up unboundedly.
		if (this.#tokenPending) {
			return
		}
		this.#tokenPending = true
		try {
			let token = await this.#driver.token
			let queued = this.#push(
				create(StreamReadMessage_FromClientSchema, {
					clientMessage: {
						case: 'updateTokenRequest',
						value: create(UpdateTokenRequestSchema, { token }),
					},
				}),
				PRIORITY_TOKEN
			)
			if (!queued) {
				this.#tokenPending = false // nothing landed on the wire; allow a retry
			}
		} catch (error) {
			this.#tokenPending = false
			throw error
		}
	}

	close(): void {
		this.#machine.dispatch({ type: 'transport.close' })
	}

	destroy(reason?: unknown): void {
		this.#machine.dispatch({ type: 'transport.destroy', reason })
	}

	#push(message: StreamReadMessage_FromClient, priority: number): boolean {
		let input = this.#streamInput
		if (!input || input.isClosed) {
			return false
		}
		input.push(message, priority)
		return true
	}

	#openStream(): void {
		void this.#closeStream()

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

		let dispatch = this.#machine.dispatch.bind(this.#machine)

		let task = (async () => {
			try {
				await this.#driver.ready(ac.signal)

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
						dispatch({
							type: 'transport.error',
							error: new YDBError(response.status, response.issues),
						})
						return
					}

					if (response.serverMessage.case === 'initResponse') {
						dbg.log(
							'recv initResponse (sessionId=%s)',
							response.serverMessage.value.sessionId
						)
						dispatch({
							type: 'transport.init',
							sessionId: response.serverMessage.value.sessionId,
						})
						continue
					}

					if (response.serverMessage.case === 'updateTokenResponse') {
						this.#tokenPending = false
					}

					dispatch({ type: 'transport.message', message: response })
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
		this.#tokenPending = false // fresh stream — the previous token, if any, is gone
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
