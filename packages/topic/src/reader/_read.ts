import { abortable } from '@ydbjs/abortable'
import { Codec } from '@ydbjs/api/topic'
import { timestampMs } from '@bufbuild/protobuf/wkt'
import { loggers } from '@ydbjs/debug'

import { TopicMessage } from '../message.js'
import { _send_read_request } from './_read_request.js'
import type { TopicPartitionSession } from '../partition-session.js'
import type { CodecMap } from '../codec.js'
import type { AsyncPriorityQueue } from '../queue.js'
import type {
	StreamReadMessage_FromClient,
	StreamReadMessage_ReadResponse,
} from '@ydbjs/api/topic'

let dbg = loggers.topic.extend('reader')

export let _read = function read(
	ctx: {
		readonly disposed: boolean
		readonly controller: AbortController
		readonly buffer: StreamReadMessage_ReadResponse[]
		readonly partitionSessions: Map<bigint, TopicPartitionSession>
		readonly codecs: CodecMap
		readonly outgoingQueue: AsyncPriorityQueue<StreamReadMessage_FromClient>
		readonly maxBufferSize: bigint
		readonly freeBufferSize: bigint
		readonly readOffsets?: Map<
			bigint,
			{ firstOffset: bigint; lastOffset: bigint }
		> // Optional for transaction support
		readonly updateFreeBufferSize: (releasedBytes: bigint) => void // Helper to update free buffer size
	},
	options: { limit?: number; waitMs?: number; signal?: AbortSignal } = {}
): AsyncIterable<TopicMessage[]> {
	let limit = options.limit || Infinity
	let signal = options.signal
	let waitMs = options.waitMs || 60_000

	dbg.log(
		'starting read operation with limit=%s, waitMs=%d, hasSignal=%s',
		limit === Infinity ? 'unlimited' : limit,
		waitMs,
		!!signal
	)
	dbg.log(
		'reader state: disposed=%s, bufferSize=%d, freeBufferSize=%d, partitionSessions=%d',
		ctx.disposed,
		ctx.buffer.length,
		ctx.freeBufferSize,
		ctx.partitionSessions.size
	)

	// Check if the reader has been disposed, cannot read with disposed reader
	if (ctx.disposed) {
		throw new Error('Reader is disposed')
	}

	// Merge the provided signal with the reader's controller signal.
	if (signal) {
		signal = AbortSignal.any([ctx.controller.signal, signal])
	} else {
		signal = ctx.controller.signal
	}

	// If the signal is already aborted, throw an error immediately.
	if (signal.aborted) {
		throw new Error('Read aborted', { cause: signal.reason })
	}

	return (async function* () {
		let messageCount = 0

		while (true) {
			dbg.log(
				'generator iteration called, messageCount=%d, limit=%s',
				messageCount,
				limit === Infinity ? 'unlimited' : limit
			)

			// If the reader is disposed, return
			if (ctx.disposed) {
				dbg.log('reader disposed during iteration, returning')
				return
			}

			// If the signal is already aborted, return
			if (signal.aborted) {
				dbg.log('signal aborted during iteration, returning')
				return
			}

			// If we've reached the limit, return
			if (messageCount >= limit) {
				dbg.log('limit reached, returning')
				return
			}

			let messages: TopicMessage[] = []

			// Wait for the next readResponse or until the timeout expires.
			if (!ctx.buffer.length) {
				dbg.log('buffer empty, waiting for data (waitMs=%d)', waitMs)
				let waiter = Promise.withResolvers()

				// Wait for new data to arrive
				let bufferCheckInterval = setInterval(() => {
					if (ctx.buffer.length > 0) {
						dbg.log(
							'data arrived in buffer, resolving waiter (bufferSize=%d)',
							ctx.buffer.length
						)
						waiter.resolve(undefined)
					}
				}, 10) // Check every 10ms

				try {
					// oxlint-disable-next-line no-await-in-loop
					await abortable(
						AbortSignal.any([signal, AbortSignal.timeout(waitMs)]),
						waiter.promise
					)
				} catch {
					if (signal.aborted) {
						dbg.log('read aborted during wait, finishing')
						return
					}

					dbg.log('wait timeout expired, yielding empty result')
					yield []
					continue
				} finally {
					clearInterval(bufferCheckInterval)
				}

				if (signal.aborted) {
					dbg.log('read aborted during wait, finishing')
					return
				}

				if (ctx.disposed) {
					dbg.log('reader disposed during wait, finishing')
					return
				}
			}

			let releasableBufferBytes = 0n
			while (ctx.buffer.length && messageCount < limit) {
				let fullRead = true
				let response = ctx.buffer.shift()! // Get the first response from the buffer

				if (response.partitionData.length === 0) {
					dbg.log('skipping empty response')
					continue // Skip empty responses
				}

				// If we have a limit and reached it, break the loop
				if (messageCount >= limit) {
					ctx.buffer.unshift(response) // Put the response back to the front of the buffer
					break
				}

				while (response.partitionData.length && messageCount < limit) {
					let pd = response.partitionData.shift()! // Get the first partition data

					if (pd.batches.length === 0) {
						dbg.log(
							'skipping empty partition data for sessionId=%s',
							pd.partitionSessionId
						)
						continue // Skip empty partition data
					}

					// If we have a limit and reached it, break the loop
					if (messageCount >= limit) {
						response.partitionData.unshift(pd) // Put the partition data back to the front of the response
						break
					}

					let partitionSession = ctx.partitionSessions.get(
						pd.partitionSessionId
					)
					if (!partitionSession) {
						dbg.log(
							'error: readResponse for unknown partitionSessionId=%s',
							pd.partitionSessionId
						)
						continue
					}

					if (partitionSession.isStopped) {
						dbg.log(
							'error: readResponse for stopped partitionSessionId=%s',
							pd.partitionSessionId
						)
						continue
					}

					while (pd.batches.length && messageCount < limit) {
						let batch = pd.batches.shift()! // Get the first batch

						if (batch.messageData.length === 0) {
							dbg.log(
								'skipping empty batch from producer=%s',
								batch.producerId
							)
							continue // Skip empty batches
						}

						// If we have a limit and reached it, break the loop
						if (messageCount >= limit) {
							pd.batches.unshift(batch) // Put the batch back to the front of the partition data
							break
						}

						while (
							batch.messageData.length &&
							messageCount < limit
						) {
							// Process each message in the batch
							let msg = batch.messageData.shift()! // Get the first message from the batch

							// If we have a limit and reached it, break the loop
							if (messageCount >= limit) {
								batch.messageData.unshift(msg) // Put the message back to the front of the batch
								break
							}

							let payload = msg.data
							if (batch.codec !== Codec.UNSPECIFIED) {
								if (!ctx.codecs.has(batch.codec)) {
									dbg.log(
										'error: codec %s is not supported',
										batch.codec
									)
									throw new Error(
										`Codec ${batch.codec} is not supported`
									)
								}

								// Decompress the message data using the provided decompress function
								try {
									payload = ctx.codecs
										.get(batch.codec)!
										.decompress(msg.data)
								} catch (error) {
									dbg.log(
										'error: failed to decompress message data: %O',
										error
									)
									throw error
								}
							}

							// Process the message
							let message: TopicMessage = new TopicMessage({
								partitionSession: partitionSession,
								producer: batch.producerId,
								payload: payload,
								codec: batch.codec,
								seqNo: msg.seqNo,
								offset: msg.offset,
								uncompressedSize: msg.uncompressedSize,
								...(msg.createdAt && {
									createdAt: timestampMs(msg.createdAt),
								}),
								...(batch.writtenAt && {
									writtenAt: timestampMs(batch.writtenAt),
								}),
								...(msg.metadataItems && {
									metadataItems: Object.fromEntries(
										msg.metadataItems.map((item) => [
											item.key,
											item.value,
										])
									),
								}),
							})

							// Track read offset for transaction support
							if (ctx.readOffsets) {
								let existing = ctx.readOffsets.get(
									pd.partitionSessionId
								)
								if (existing) {
									// Update last offset, keep first offset
									existing.lastOffset = msg.offset
								} else {
									// First message for this partition session
									ctx.readOffsets.set(pd.partitionSessionId, {
										firstOffset: msg.offset,
										lastOffset: msg.offset,
									})
								}
							}

							messages.push(message)
							messageCount++
						}

						if (batch.messageData.length != 0) {
							fullRead = false
							pd.batches.unshift(batch) // Put the batch back to the front of the partition data
						}
					}

					if (pd.batches.length != 0) {
						fullRead = false
						response.partitionData.unshift(pd) // Put the partition data back to the front of the response
					}
				}
				if (response.partitionData.length != 0) {
					fullRead = false
					ctx.buffer.unshift(response) // Put the response back to the front of the buffer
				}

				// If we have read all messages from the response, we can release its buffer allocation
				if (response.partitionData.length === 0 && fullRead) {
					releasableBufferBytes += response.bytesSize
					dbg.log(
						'response fully processed, releasing %s bytes from buffer',
						response.bytesSize
					)
				}
			}

			dbg.log(
				'message processing complete: yielding %d messages, total messageCount=%d',
				messages.length,
				messageCount
			)
			dbg.log(
				'buffer state: bufferSize=%d, maxBufferSize=%d, freeBufferSize=%d, releasableBytes=%s',
				ctx.buffer.length,
				ctx.maxBufferSize,
				ctx.freeBufferSize,
				releasableBufferBytes
			)

			dbg.log(
				'yield %d messages, buffer size is %d bytes, free buffer size is %d bytes',
				messages.length,
				ctx.maxBufferSize - ctx.freeBufferSize,
				ctx.freeBufferSize
			)

			if (releasableBufferBytes > 0n) {
				// Update free buffer size using helper function
				ctx.updateFreeBufferSize(releasableBufferBytes)

				// If we have free buffer space, request more data.
				_send_read_request({
					queue: ctx.outgoingQueue,
					bytesSize: releasableBufferBytes,
				})
			}

			dbg.log('generator yielding: messagesCount=%d', messages.length)
			yield messages

			// If we've reached the limit or no messages were yielded and buffer is empty, return
			if (
				messageCount >= limit ||
				(messages.length === 0 && !ctx.buffer.length)
			) {
				return
			}
		}
	})()
}
