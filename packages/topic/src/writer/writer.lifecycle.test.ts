import { create } from '@bufbuild/protobuf'
import { anyPack } from '@bufbuild/protobuf/wkt'
import { abortable } from '@ydbjs/abortable'
import { DiscoveryServiceDefinition, ListEndpointsResultSchema } from '@ydbjs/api/discovery'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import {
	Codec,
	StreamWriteMessage_FromServerSchema,
	TopicServiceDefinition,
} from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'
import { Server } from '@ydbjs/grpc'
import { expect, test, vi } from 'vitest'

import { initResponse } from './writer.fixtures.ts'
import { createTopicWriter } from './writer.ts'
import { WriterTransport } from './transport.ts'

test.for([
	{ graceful: false, failure: 'destroy' },
	{ graceful: true, failure: 'destroy' },
	{ graceful: false, failure: 'runtime' },
])(
	'preserves the $failure reason during completion-hook reentry (graceful close: $graceful)',
	async ({ graceful, failure }, tc) => {
		let received = Promise.withResolvers<AbortSignal>()
		let port = 0
		using server = new Server()
		server.add(DiscoveryServiceDefinition, {
			listEndpoints() {
				let result = create(ListEndpointsResultSchema, {
					endpoints: [{ nodeId: 1, address: '127.0.0.1', port }],
				})
				return {
					operation: {
						ready: true,
						status: StatusIds_StatusCode.SUCCESS,
						result: anyPack(ListEndpointsResultSchema, result),
					},
				}
			},
		})
		server.add(TopicServiceDefinition, {
			async *streamWrite(requests, context) {
				for await (let request of requests) {
					if (request.clientMessage.case === 'initRequest') {
						yield initResponse(0n)
					} else if (request.clientMessage.case === 'writeRequest') {
						received.resolve(context.signal)
					}
				}
			},
		})
		port = await server.listen('127.0.0.1:0')
		let completions = 0
		using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
			hooks: {
				onCall(event) {
					if (event.method !== TopicServiceDefinition.streamWrite.path) return
					return () => {
						completions++
						writer.destroy()
					}
				},
			},
		})
		await driver.ready(tc.signal)
		using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })
		writer.write(new Uint8Array([1]))
		let flushed = writer.flush(tc.signal).catch((error: unknown) => error)
		let serverSignal = await abortable(tc.signal, received.promise)
		let closing = graceful
			? writer.close(tc.signal).catch((error: unknown) => error)
			: undefined
		let reason = new Error(
			failure === 'runtime' ? 'Writer runtime failed' : 'Application stopped the writer'
		)
		let stopped: Promise<unknown>

		if (failure === 'runtime') {
			// An internal send-effect failure cannot be scheduled by a server response.
			using send = vi.spyOn(WriterTransport.prototype, 'sendBatch')
			send.mockImplementationOnce(() => {
				throw reason
			})
			writer.write(new Uint8Array([2]))
			stopped = writer.flush(tc.signal).catch((error: unknown) => error)
			await stopped
		} else {
			writer.destroy(reason)
			stopped = writer.flush(tc.signal).catch((error: unknown) => error)
		}

		expect(completions).toBe(1)
		let stoppedError = await stopped
		expect(stoppedError).toBe(reason)
		let flushError = await flushed
		expect(flushError).toBe(reason)
		closing ??= writer.close(tc.signal).catch((error: unknown) => error)
		let closeError = await closing
		expect(closeError).toBe(reason)
		let closed = writer.close(tc.signal)
		await expect(closed).rejects.toBe(reason)
		await expect.poll(() => serverSignal.aborted).toBe(true)
	}
)

test('preserves a rejected codec error when its completion hook destroys the writer', async (tc) => {
	let writes = 0
	let completions = 0
	let received = Promise.withResolvers<AbortSignal>()
	let port = 0
	using server = new Server()
	server.add(DiscoveryServiceDefinition, {
		listEndpoints() {
			let result = create(ListEndpointsResultSchema, {
				endpoints: [{ nodeId: 1, address: '127.0.0.1', port }],
			})
			return {
				operation: {
					ready: true,
					status: StatusIds_StatusCode.SUCCESS,
					result: anyPack(ListEndpointsResultSchema, result),
				},
			}
		},
	})
	server.add(TopicServiceDefinition, {
		async *streamWrite(requests, context) {
			for await (let request of requests) {
				if (request.clientMessage.case === 'initRequest') {
					received.resolve(context.signal)
					yield create(StreamWriteMessage_FromServerSchema, {
						status: StatusIds_StatusCode.SUCCESS,
						serverMessage: {
							case: 'initResponse',
							value: { supportedCodecs: { codecs: [Codec.GZIP] } },
						},
					})
				} else if (request.clientMessage.case === 'writeRequest') {
					writes++
				}
			}
		},
	})
	port = await server.listen('127.0.0.1:0')
	using driver = new Driver(`grpc://127.0.0.1:${port}/local`, {
		hooks: {
			onCall(event) {
				if (event.method !== TopicServiceDefinition.streamWrite.path) return
				return () => {
					completions++
					writer.destroy()
				}
			},
		},
	})
	using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })
	writer.write(new Uint8Array([1]))
	let flushed = writer.flush(tc.signal).catch((error: unknown) => error)
	let serverSignal = await abortable(tc.signal, received.promise)
	let failure = await flushed

	expect(failure).toBeInstanceOf(Error)
	expect(failure).toMatchObject({
		message: `Codec ${Codec.RAW} is not allowed by the topic (supported codecs: ${Codec.GZIP})`,
	})
	expect(completions).toBe(1)
	expect(writes).toBe(0)
	let closed = writer.close(tc.signal)
	await expect(closed).rejects.toBe(failure)
	await expect.poll(() => serverSignal.aborted).toBe(true)
})
