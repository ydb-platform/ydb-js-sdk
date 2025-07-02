import { setInterval } from 'node:timers/promises'

import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import {
	Codec,
	type StreamWriteMessage_FromClient,
	type StreamWriteMessage_WriteRequest_MessageData,
	TopicServiceDefinition,
} from '@ydbjs/api/topic'
import type { Driver } from '@ydbjs/core'
import { loggers } from '@ydbjs/debug'
import { YDBError } from '@ydbjs/error'
import { type RetryConfig, retry } from '@ydbjs/retry'
import { backoff, combine, jitter } from '@ydbjs/retry/strategy'

import { type CompressionCodec, defaultCodecMap } from '../codec.js'
import { AsyncPriorityQueue } from '../queue.js'
import type { TX } from '../tx.js'
import { _flush } from './_flush.js'
import { _get_producer_id } from './_gen_producer_id.js'
import { _on_init_response } from './_init_reponse.js'
import { _send_init_request } from './_init_request.js'
import { _send_update_token_request } from './_update_token.js'
import { _write } from './_write.js'
import { _on_write_response } from './_write_response.js'
import type { ThroughputSettings } from './types.js'

export type TopicWriterOptions = {
	// Transaction identity.
	// If provided, the writer will use the transaction for writing messages.
	tx?: TX
	// Path to the topic to write to.
	// Example: "/Root/my-topic"
	topic: string
	// Compression codec to use for writing messages.
	// If not provided, the RAW codec will be used by default.
	// Default supported codecs: RAW_CODEC, GZIP_CODEC, ZSTD_CODEC.
	codec?: CompressionCodec
	// The producer name to use for writing messages.
	// If not provided, a random producer name will be generated.
	producer?: string
	// How often to update the token for the writer.
	// Default is 60 seconds.
	updateTokenIntervalMs?: number
	// Maximum size of the buffer in bytes.
	// If the buffer exceeds this size, the writer will flush the buffer and send the messages to the topic.
	// This is useful to avoid memory leaks and to ensure that the writer does not hold too many messages in memory.
	// If not provided, the default buffer size is 256MiB.
	maxBufferBytes?: bigint
	// Maximum number of messages that can be in flight at the same time.
	// If the number of messages in flight exceeds this number, the writer will wait for some messages to be acknowledged before sending new messages.
	// This is useful to avoid overwhelming the topic with too many messages at once.
	// Default is 1000 messages.
	maxInflightCount?: number
	// The Interval in milliseconds to flush the buffer automatically.
	// If not provided, the writer will not flush the buffer automatically.
	// This is useful to ensure that the writer does not hold too many messages in memory.
	// Default is 10ms.
	flushIntervalMs?: number
	// Retry configuration for the writer.
	retryConfig?(signal: AbortSignal): RetryConfig
	// Callback that is called when writer receives an acknowledgment for a message.
	onAck?: (seqNo: bigint, status?: 'skipped' | 'written' | 'writtenInTx') => void
}

export interface TopicWriter extends Disposable, AsyncDisposable {
	// Write a message to the topic.
	// Returns a promise that resolves to the sequence number of the message that was written to the topic.
	write(
		payload: Uint8Array,
		extra?: { seqNo?: bigint; createdAt?: Date; metadataItems?: Record<string, Uint8Array> }
	): bigint
	// Flush the buffer and send all messages to the topic.
	// Returns a promise that resolves to the last sequence number of the topic after flushing.
	flush(): Promise<bigint | undefined>
	// Gracefully close the writer. Stop accepting new messages and wait for existing ones to be sent.
	close(): Promise<void>
	// Immediately destroy the writer and release all resources.
	// This will stop all operations immediately without waiting for pending messages.
	destroy(reason?: Error): void
}

export const createTopicWriter = function createTopicWriter(driver: Driver, options: TopicWriterOptions): TopicWriter {
	options.producer ??= _get_producer_id()
	options.updateTokenIntervalMs ??= 60_000 // Default is 60 seconds.

	// Throughput options
	let throughputSettings: ThroughputSettings = {
		maxBufferBytes: (options.maxBufferBytes ??= 1024n * 1024n * 256n), // Default is 256MiB.
		flushIntervalMs: (options.flushIntervalMs ??= 10), // Default is 10ms.
		maxInflightCount: (options.maxInflightCount ??= 1000), // Default is 1000 messages.
	}

	let dbg = loggers.topic.extend('writer')

	// If the user does not provide a compression codec, use the RAW codec by default.
	let codec: CompressionCodec = options.codec ?? defaultCodecMap.get(Codec.RAW)!

	// Last sequence number of the topic.
	// Automatically get the last sequence number of the topic before starting to write messages.
	let lastSeqNo: bigint | undefined = undefined
	// Flag to indicate if the sequence number is provided by the user.
	// If the user provides a sequence number, it will be used instead of the computed sequence number.
	// If the user provides a sequence number, all subsequent messages must have a sequence number provided.
	let isSeqNoProvided = false

	// Array of messages that are currently in the buffer.
	// This is used to keep track of messages that are not yet sent to the server.
	let buffer: StreamWriteMessage_WriteRequest_MessageData[] = []
	// In-flight messages that are not yet acknowledged.
	// This is used to keep track of messages that are currently being sent to the server.
	let inflight: StreamWriteMessage_WriteRequest_MessageData[] = []

	// Current size of buffers in bytes.
	// This is used to keep track of the amount of data in buffers.
	let bufferSize = 0n

	// Abort controller for cancelling requests.
	let ac = new AbortController()
	let signal = ac.signal

	// Flag to indicate if the writer is closed.
	// When the writer is closed, it will not accept new messages.
	// The writer will still process and acknowledge any messages that were already sent.
	let isClosed = false
	// Flag to indicate if the writer is currently flushing.
	// When flushing, new messages are temporarily blocked to ensure flush completes.
	let isFlushing = false
	// Flag to indicate if the writer is disposed.
	// When the writer is disposed, it will not accept new messages and will reject all pending write requests.
	// This is useful to ensure that the writer does not leak resources and can be closed gracefully.
	let isDisposed = false

	// This function is used to update the last sequence number of the topic.
	let updateLastSeqNo = function updateLastSeqNo(seqNo: bigint) {
		lastSeqNo = seqNo
	}

	// This function is used to update the buffer size when a message is added to the buffer.
	let updateBufferSize = function updateBufferSize(bytes: bigint) {
		bufferSize += bytes
	}

	// Create an outgoing stream that will be used to send messages to the topic service.
	// Queue starts paused initially since we haven't sent init request yet
	let outgoing = new AsyncPriorityQueue<StreamWriteMessage_FromClient>()
	// Note: Will be paused after init request is sent

	// Flush the buffer periodically to ensure that messages are sent to the topic.
	// This is useful to avoid holding too many messages in memory and to ensure that the writer does not leak memory.
	// The flush interval is configurable and defaults to 60 seconds.
	void (async function backgroundFlusher() {
		try {
			for await (let _ of setInterval(options.flushIntervalMs, void 0, { signal })) {
				_flush({
					queue: outgoing,
					codec: codec,
					buffer,
					inflight,
					throughputSettings,
					updateBufferSize,
					...(options.tx && { tx: options.tx }),
				})
			}
		} catch (error) {
			// Handle abort signal or other errors silently during disposal
			if (!signal.aborted) {
				dbg.log('background flusher error: %O', error)
			}
		}
	})()

	// Update the token periodically to ensure that the writer has a valid token.
	// This is useful to avoid token expiration and to ensure that the writer can continue to write messages to the topic.
	// The update token interval is configurable and defaults to 60 seconds.
	void (async function backgroundTokenRefresher() {
		try {
			for await (let _ of setInterval(options.updateTokenIntervalMs, void 0, { signal })) {
				_send_update_token_request({
					queue: outgoing,
					token: await driver.token,
				})
			}
		} catch (error) {
			// Handle abort signal or other errors silently during disposal
			if (!signal.aborted) {
				dbg.log('background token refresher error: %O', error)
			}
		}
	})()

	// Start the stream to the topic service.
	// This is the main function that will handle the streaming of messages to the topic service.
	// It will handle the initialization of the stream, sending messages to the topic service,
	// and handling responses from the topic service.
	// It will also handle retries in case of errors or connection failures.
	// The stream will be retried if it fails or receives an error.
	void (async function stream() {
		await driver.ready(signal)

		let retryConfig = options.retryConfig?.(signal)
		retryConfig ??= {
			retry: true,
			signal: signal,
			budget: Infinity,
			strategy: combine(jitter(50), backoff(50, 5000)),
			onRetry(ctx) {
				dbg.log('retrying stream connection, attempt %d, error: %O', ctx.attempt, ctx.error)
			},
		}

		try {
			// Start the stream to the topic service.
			// Retry the connection if it fails or receives an error.
			await retry(retryConfig, async (signal) => {
				// Close old queue and create new empty one for retry
				outgoing.dispose()
				outgoing = new AsyncPriorityQueue<StreamWriteMessage_FromClient>()

				let stream = driver.createClient(TopicServiceDefinition).streamWrite(outgoing, { signal })

				// Send the initial request to the server to initialize the stream.
				dbg.log('sending init request to server, producer: %s', options.producer)

				_send_init_request({
					queue: outgoing,
					topic: options.topic,
					producer: options.producer!,
					getLastSeqNo: true,
				})

				// Pause after next tick to allow init request to be consumed first
				process.nextTick(() => {
					outgoing.pause()
				})

				let dbgrpc = dbg.extend('grpc')

				for await (const chunk of stream) {
					dbgrpc.log('receive %s with status %d', chunk.serverMessage.value?.$typeName, chunk.status)

					if (chunk.status !== StatusIds_StatusCode.SUCCESS) {
						console.error('error occurred while streaming: %O', chunk.issues)

						let error = new YDBError(
							chunk.status || StatusIds_StatusCode.STATUS_CODE_UNSPECIFIED,
							chunk.issues || []
						)
						throw error
					}

					switch (chunk.serverMessage.case) {
						case 'initResponse':
							_on_init_response(
								{
									queue: outgoing,
									codec: codec,
									buffer,
									inflight,
									throughputSettings,
									updateLastSeqNo,
									updateBufferSize,
									...(options.tx && { tx: options.tx }),
									...(lastSeqNo && { lastSeqNo })
								},
								chunk.serverMessage.value
							)

							outgoing.resume() // Now we can start sending messages

							break
						case 'writeResponse':
							_on_write_response(
								{
									queue: outgoing,
									codec: codec,
									buffer,
									inflight,
									throughputSettings,
									updateBufferSize,
									...(options.tx && { tx: options.tx }),
									...(options.onAck && { onAck: options.onAck }),
								},
								chunk.serverMessage.value
							)
							break
					}
				}
			})
		} catch (err) {
			if (!signal.aborted) {
				dbg.log('error occurred while streaming: %O', err)
			}
		} finally {
			dbg.log('stream closed')
			destroy()
		}
	})()

	dbg.log('creating writer with producer: %s, topic: %s', options.producer, options.topic)

	// outgoing queue pause/resume
	let originalPause = outgoing.pause.bind(outgoing)
	let originalResume = outgoing.resume.bind(outgoing)
	outgoing.pause = () => {
		dbg.log('outgoing queue paused')
		return originalPause()
	}
	outgoing.resume = () => {
		dbg.log('outgoing queue resumed')
		return originalResume()
	}

	// This function is used to write a message to the topic.
	// It will add the message to the buffer and return a promise.
	// If writer is not ready, it will add the message to the write queue and return a promise.
	// Promise will be resolved when the message is acknowledged by the topic service.
	// Returns the sequence number of the message that was written to the topic.
	// If the sequence number is not provided, it will use the last sequence number of the topic.
	function write(
		payload: Uint8Array,
		extra: { seqNo?: bigint; createdAt?: Date; metadataItems?: { [key: string]: Uint8Array } } = {}
	): bigint {
		if (isDisposed) {
			throw new Error('Writer is destroyed, cannot write messages')
		}

		if (isFlushing) {
			throw new Error('Writer is flushing, cannot write messages during flush')
		}

		if (isClosed) {
			throw new Error('Writer is closed, cannot write messages')
		}

		if (!extra.seqNo && isSeqNoProvided) {
			throw new Error(
				'Missing sequence number for message. Sequence number is provided by the user previously, so after that all messages must have seqNo provided'
			)
		}

		if (extra.seqNo) {
			isSeqNoProvided = true
		}

		return _write(
			{
				codec: codec,
				buffer,
				inflight,
				lastSeqNo: (lastSeqNo || extra.seqNo)!,
				updateLastSeqNo,
				updateBufferSize,
			},
			{
				data: payload,
				...(extra.seqNo && { seqNo: extra.seqNo }),
				...(extra.createdAt && { createdAt: extra.createdAt }),
				...(extra.metadataItems && { metadataItems: extra.metadataItems }),
			}
		)
	}

	if (options.onAck) {
		let originalOnAck = options.onAck
		options.onAck = (seqNo, status) => {
			dbg.log('ack: seqNo: %s, status: %s', seqNo, status)
			try {
				originalOnAck(seqNo, status)
			} catch (err) {
				dbg.log('onAck callback error: %O', err)
			}
		}
	}

	// This function is used to flush the buffer and send the messages to the topic.
	// It will send all messages in the buffer to the topic service and wait for them to be acknowledged.
	// If the buffer is empty, it will return immediately.
	// Returns the last sequence number of the topic after flushing.
	async function flush(): Promise<bigint | undefined> {
		if (isDisposed) {
			throw new Error('Writer is destroyed')
		}

		if (!buffer.length && !inflight.length) {
			dbg.log('flush: nothing to flush')
			return lastSeqNo
		}

		isFlushing = true

		try {
			let prevBuffer = buffer.length
			let prevInflight = inflight.length
			dbg.log('flush: starting, buffer: %d, inflight: %d', buffer.length, inflight.length)

			while (buffer.length > 0 || inflight.length > 0) {
				if (isDisposed) {
					throw new Error('Writer was destroyed during flush')
				}

				if (buffer.length !== prevBuffer || inflight.length !== prevInflight) {
					dbg.log('flush progress: inflight: %d, buffer: %d', inflight.length, buffer.length)
					prevBuffer = buffer.length
					prevInflight = inflight.length
				}

				_flush({
					queue: outgoing,
					codec: codec,
					buffer,
					inflight,
					throughputSettings,
					updateBufferSize,
					...(options.tx && { tx: options.tx }),
				})

				// eslint-disable-next-line
				await new Promise((resolve) => setTimeout(resolve, throughputSettings.flushIntervalMs, { signal }))
			}
			dbg.log('flush: complete, lastSeqNo: %s', lastSeqNo)
			return lastSeqNo
		} finally {
			isFlushing = false
		}
	}

	// Gracefully close the writer - stop accepting new messages and wait for existing ones
	async function close(): Promise<void> {
		if (isDisposed) {
			throw new Error('Writer is already destroyed')
		}

		if (isClosed) {
			return // Already closed
		}

		// Stop accepting new messages
		isClosed = true

		try {
			// Wait for existing messages to be sent
			await flush()
		} catch (err) {
			dbg.log('error during close: %O', err)
			throw err
		}

		dbg.log('writer closed gracefully')
		destroy()
	}

	// Immediate destruction - stop everything immediately
	function destroy() {
		if (isDisposed) {
			return
		}

		// Dispose the outgoing queue
		outgoing.dispose()

		// Abort all operations
		ac.abort()

		// Clear the buffer and inflight messages
		buffer.length = 0
		bufferSize = 0n
		inflight.length = 0

		isClosed = true
		isDisposed = true
		isFlushing = false // Reset flushing flag
	}

	// Before committing the transaction, require all messages to be written and acknowledged.
	options.tx?.registerPrecommitHook(async () => {
		if (isDisposed) {
			return
		}

		// Close the writer. Do not accept new messages.
		isClosed = true
		// Wait for all messages to be flushed.
		await flush()
	})

	return {
		flush,
		write,
		close,
		destroy,
		[Symbol.dispose]: () => {
			destroy()
		},
		[Symbol.asyncDispose]: async () => {
			// Graceful async disposal: wait for existing messages to be sent
			if (!isClosed && !isDisposed) {
				try {
					await close() // Use graceful close
				} catch (error) {
					dbg.log('error during async dispose close: %O', error)
				}
			}
			destroy()
		},
	}
}

export const createTopicTxWriter = function createTopicTxWriter(
	driver: Driver,
	tx: { registerPrecommitHook: (fn: () => Promise<void> | void) => void; sessionId: string; transactionId: string },
	options: TopicWriterOptions
): TopicWriter {
	return createTopicWriter(driver, {
		...options,
		tx,
	})
}
