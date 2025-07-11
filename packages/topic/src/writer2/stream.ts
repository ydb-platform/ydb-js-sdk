import { setInterval } from 'node:timers/promises'

import { create } from '@bufbuild/protobuf'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import {
	type StreamWriteMessage_FromClient,
	StreamWriteMessage_FromClientSchema,
	type StreamWriteMessage_InitRequest,
	StreamWriteMessage_InitRequestSchema,
	type StreamWriteMessage_InitResponse,
	type StreamWriteMessage_WriteRequest,
	StreamWriteMessage_WriteRequestSchema,
	type StreamWriteMessage_WriteResponse,
	TopicServiceDefinition,
	UpdateTokenRequestSchema,
	type UpdateTokenResponse,
} from '@ydbjs/api/topic'
import { loggers } from '@ydbjs/debug'
import { YDBError } from '@ydbjs/error'
import { fromCallback } from 'xstate'
import { AsyncPriorityQueue } from '../queue.ts'
import { _batch_messages } from '../writer/_batch_messages.ts'
import { _send_init_request } from '../writer/_init_request.ts'
import { _send_update_token_request } from '../writer/_update_token.ts'
import { _emit_write_request } from '../writer/_write_request.ts'

const DEFAULT_UPDATE_TOKEN_INTERVAL_MS = 60_000

// Input type for the stream actor (this is passed to the actor on creation)
export interface WriterStreamInput {
	driver: import('@ydbjs/core').Driver
	updateTokenIntervalMs?: number
}

// Events that the stream actor can receive
export type WriterStreamReceiveEvent =
	| {
		type: 'writer.stream.request.init'
		data: StreamWriteMessage_InitRequest
	}
	| {
		type: 'writer.stream.request.write'
		data: StreamWriteMessage_WriteRequest
	}

// Events that the stream actor can send back
export type WriterStreamEmittedEvent =
	| {
		type: 'writer.stream.start'
	}
	| {
		type: 'writer.stream.response.init'
		data: StreamWriteMessage_InitResponse
	}
	| {
		type: 'writer.stream.response.write'
		data: StreamWriteMessage_WriteResponse
	}
	| {
		type: 'writer.stream.response.token'
		data: UpdateTokenResponse
	}
	| {
		type: 'writer.stream.error'
		error: unknown
	}
	| {
		type: 'writer.stream.close'
	}

export const WriterStream = fromCallback<
	WriterStreamReceiveEvent,
	WriterStreamInput,
	WriterStreamEmittedEvent
>(({ input, sendBack, receive }) => {
	let ac = new AbortController()
	let queue = new AsyncPriorityQueue<StreamWriteMessage_FromClient>()

	// Handle incoming commands
	receive((event: WriterStreamReceiveEvent) => {
		switch (event.type) {
			case 'writer.stream.request.init':
				loggers.grpc.log(`%s/%s`, TopicServiceDefinition.streamWrite.path, StreamWriteMessage_InitRequestSchema.typeName)

				return queue.push(create(StreamWriteMessage_FromClientSchema, {
					clientMessage: {
						case: 'initRequest',
						value: event.data
					}
				}), 100)
			case 'writer.stream.request.write':
				loggers.grpc.log(`%s/%s`, TopicServiceDefinition.streamWrite.path, StreamWriteMessage_WriteRequestSchema.typeName)

				return queue.push(create(StreamWriteMessage_FromClientSchema, {
					clientMessage: {
						case: 'writeRequest',
						value: event.data
					}
				}))
		}
	})

	let stream = async () => {
		await input.driver.ready(ac.signal)

		let stream = input.driver
			.createClient(TopicServiceDefinition)
			.streamWrite(queue, { signal: ac.signal })

		sendBack({ type: 'writer.stream.start' })

		for await (let event of stream) {
			loggers.grpc.log(`%s/%s`, TopicServiceDefinition.streamWrite.path, event.serverMessage.value?.$typeName, event.status)

			if (ac.signal.aborted) {
				break
			}

			if (event.status !== StatusIds_StatusCode.SUCCESS) {
				throw new YDBError(event.status, event.issues)
			}

			switch (event.serverMessage.case) {
				case 'initResponse':
					sendBack({
						type: 'writer.stream.response.init',
						data: event.serverMessage.value
					})
					break
				case 'writeResponse':
					sendBack({
						type: 'writer.stream.response.write',
						data: event.serverMessage.value
					})
					break
				case 'updateTokenResponse':
					sendBack({
						type: 'writer.stream.update.response.token',
						data: event.serverMessage.value
					})
					break
				default:
					sendBack({
						type: 'writer.stream.error',
						error: new Error('Received unknown message type: ' + event.serverMessage.case)
					})
			}
		}
	}

	let authorizer = async () => {
		await input.driver.ready(ac.signal)

		let interval = input.updateTokenIntervalMs ?? DEFAULT_UPDATE_TOKEN_INTERVAL_MS
		for await (let _ of setInterval(interval, null, { signal: ac.signal })) {
			let token = await input.driver.token
			queue.push(create(StreamWriteMessage_FromClientSchema, {
				clientMessage: {
					case: 'updateTokenRequest',
					value: create(UpdateTokenRequestSchema, { token })
				}
			}), 10)
		}
	}

	void stream()
		.catch(error => sendBack({ type: 'writer.stream.error', error }))
		.finally(() => sendBack({ type: 'writer.stream.close' }))

	void authorizer()
		.catch(error => sendBack({ type: 'writer.stream.error', error }))

	return () => {
		queue.close()
		ac.abort()
	}
})
