/**
 * @fileoverview YDB Topic Writer State Machine
 *
 * Implements a high-performance state machine for writing messages to YDB Topics.
 * Handles connection management, batching, flow control, error recovery, shutdown, and memory management.
 *
 * Key Features:
 * - Sliding window message buffer for efficient memory usage
 * - Automatic batching with size and inflight constraints
 * - Flow control via maxBufferBytes and maxInflightCount
 * - Configurable garbage collection thresholds
 * - Exponential backoff for error recovery
 * - Resource cleanup on close/destroy
 *
 * Memory Management:
 * Uses a single messages array with sliding window approach:
 * [garbage...][inflight...][buffer...]
 *  ↑          ↑            ↑
 *  0          inflightStart bufferStart
 *
 * Messages flow: buffer → inflight → garbage → compacted
 */

import * as assert from 'node:assert'

import { create } from '@bufbuild/protobuf'
import { timestampFromDate } from '@bufbuild/protobuf/wkt'
import {
	Codec,
	StreamWriteMessage_InitRequestSchema,
	StreamWriteMessage_WriteRequestSchema,
	StreamWriteMessage_WriteRequest_MessageDataSchema,
	TransactionIdentitySchema,
} from '@ydbjs/api/topic'
import type { Driver } from '@ydbjs/core'
import { isRetryableError } from '@ydbjs/retry'
import { assign, enqueueActions, sendTo, setup } from 'xstate'
import { defaultCodecMap } from '../codec.js'
import { WriterStream, type WriterStreamReceiveEvent } from './stream.js'
import type {
	TopicWriterOptions,
	WriterContext,
	WriterEmitted,
	WriterEvents,
	WriterInput,
} from './types.js'
import { loggers } from '@ydbjs/debug'

// ============================================================================
// CONSTANTS AND LIMITS
// ============================================================================

// YDB Topic service limits - hard limits imposed by the service
export const MAX_BATCH_SIZE = 50n * 1024n * 1024n // Maximum batch size in bytes (50MiB)
export const MAX_PAYLOAD_SIZE = 48n * 1024n * 1024n // Maximum payload size in bytes (48MiB)

// Default garbage collection thresholds (configurable via options)
// These thresholds determine when memory is reclaimed from acknowledged messages
export const DEFAULT_GARBAGE_COUNT_THRESHOLD = 1000 // Reclaim memory when >1000 garbage messages
export const DEFAULT_GARBAGE_SIZE_THRESHOLD = 100n * 1024n * 1024n // Reclaim memory when >100MB garbage

// ============================================================================
// UTILITIES
// ============================================================================

// Factory function for creating log actions with parameterized messages
let log = (message: string) => ({
	type: 'log' as const,
	params: { message },
})

function formatLog(
	template: string,
	vars: Record<string, string | number>
): string {
	return template.replace(/\{(\w+)\}/g, (_, key) =>
		vars[key] !== undefined ? String(vars[key]) : `{${key}}`
	)
}

/**
 * Formats byte sizes into human-readable strings using binary prefixes.
 * Example outputs: "1.5GiB", "256MiB", "4KiB", "512b".
 *
 * @param bytes - Size in bytes as bigint
 * @returns Formatted string
 */

let formatSize = (bytes: bigint): string => {
	let size = Number(bytes)
	if (size < 1024) return `${size}b`

	let kib = size / 1024
	if (size < 1024 * 1024) return `${Math.round(kib)}KiB`

	let mib = size / (1024 * 1024)
	if (size < 1024 * 1024 * 1024) {
		// Don't switch to GiB if precision would be lost
		// Use GiB only if MiB value is >= 1000 (close to 1024)
		if (mib >= 1000) {
			let gib = size / (1024 * 1024 * 1024)
			return `${Math.round(gib * 10) / 10}GiB`
		}
		return `${Math.round(mib)}MiB`
	}

	let gib = size / (1024 * 1024 * 1024)
	return `${Math.round(gib * 10) / 10}GiB`
}

// ============================================================================
// STATE MACHINE DEFINITION
// ============================================================================

/**
 * Factory function for creating the writer state machine.
 * Provides typed context, events, and actions for better type safety and reusability.
 *
 * State Machine Overview:
 * - States:
 *   - `idle`: Initial state, waiting for connection.
 *   - `connecting`: Establishing connection to YDB.
 *   - `connected`: Connection established, ready to send messages.
 *   - `sending`: Actively sending messages.
 *   - `error`: Error occurred, retrying or shutting down.
 *   - `closed`: Graceful shutdown completed.
 *
 * - Transitions:
 *   - `idle` → `connecting`: Triggered by start action.
 *   - `connecting` → `connected`: Triggered by successful connection.
 *   - `connected` → `sending`: Triggered by message enqueue.
 *   - `sending` → `connected`: Triggered by message acknowledgment.
 *   - `connected` → `error`: Triggered by non-retryable error.
 *   - `error` → `connecting`: Triggered by retryable error.
 *   - `connected` → `closed`: Triggered by shutdown action.
 */

let writerMachineFactory = setup({
	types: {
		input: {} as WriterInput,
		events: {} as WriterEvents,
		emitted: {} as WriterEmitted,
		context: {} as WriterContext,
	},

	actors: {
		WriterStream,
	},

	actions: {
		// ====================================================================
		// LOGGING AND DEBUGGING ACTIONS
		// ====================================================================

		log: ({ context, event }, params: { message: string }) => {
			if (!context.dbg.enabled) {
				return
			}

			let ackCount = 0
			if (
				event.type === 'writer.stream.response.write' &&
				event.data?.acks
			) {
				ackCount = event.data.acks.length
			}

			let garbageCount = context.inflightStart
			let pendingCount = context.bufferLength + context.inflightLength
			let pendingSize = context.bufferSize + context.inflightSize

			let topicPath = context.options.topic.startsWith(
				`${context.driver.database}`
			)
				? context.options.topic
				: `${context.driver.database}/${context.options.topic}`

			let vars: Record<string, any> = {
				eventType: event.type,
				topicPath,
				lastError: context.lastError,
				sessionId: context.sessionId || 'none',
				producerId: context.producerId || 'none',
				bufferLength: context.bufferLength,
				inflightLength: context.inflightLength,
				attempts: context.attempts,
				ackCount,
				arrayLength: context.messages.length,
				bufferStart: context.bufferStart,
				inflightStart: context.inflightStart,
				bufferSize: formatSize(context.bufferSize),
				inflightSize: formatSize(context.inflightSize),
				garbageCount,
				garbageSize: formatSize(context.garbageSize),
				pendingCount,
				pendingSize: formatSize(pendingSize),
			}

			vars.stats =
				`total=${context.messages.length}` +
				` pending=${pendingCount}(${formatSize(pendingSize)})` +
				` buffer=${context.bufferLength}(${formatSize(context.bufferSize)})` +
				` inflight=${context.inflightLength}(${formatSize(context.inflightSize)})` +
				` garbage=${garbageCount}(${formatSize(context.garbageSize)})`

			context.dbg.log(formatLog(params.message, vars))
		},

		// ====================================================================
		// CONNECTION MANAGEMENT ACTIONS
		// ====================================================================

		/**
		 * Spawns the stream actor for YDB topic communication.
		 * Used to establish a connection.
		 *
		 * @param context - State machine context containing driver and options
		 * @returns Reference to the spawned stream actor
		 */
		createConnection: assign({
			streamRef: ({ context, spawn }) => {
				return spawn('WriterStream', {
					id: 'WriterStream',
					input: {
						driver: context.driver,
						...(context.options.updateTokenIntervalMs !==
							undefined && {
							updateTokenIntervalMs:
								context.options.updateTokenIntervalMs,
						}),
					},
				})
			},
		}),
		/**
		 * Stops the stream actor and clears its reference.
		 * Used during shutdown or error handling.
		 *
		 * @param enqueue - Enqueue function for scheduling actions
		 */
		closeConnection: enqueueActions(({ enqueue }) => [
			enqueue.assign({ streamRef: undefined }),
			enqueue.stopChild('WriterStream'),
		]),
		/**
		 * Sends an init request to the stream actor to start a write session.
		 * Includes session configuration like topic path and producer ID.
		 *
		 * @param context - State machine context containing session options
		 * @returns Init request event for the stream actor
		 */
		createWriteSession: sendTo('WriterStream', ({ context }) => {
			return {
				type: 'writer.stream.request.init',
				data: create(StreamWriteMessage_InitRequestSchema, {
					path: context.options.topic,
					producerId: context.producerId,
					getLastSeqNo: true,
					...(context.messageGroupId && {
						partitioning: {
							case: 'messageGroupId',
							value: context.messageGroupId,
						},
					}),
					...(context.partitionId && {
						partitioning: {
							case: 'partitionId',
							value: context.partitionId,
						},
					}),
				}),
			} satisfies WriterStreamReceiveEvent
		}),

		// ====================================================================
		// SESSION MANAGEMENT ACTIONS
		// ====================================================================

		/**
		 * Updates session state after receiving an init response.
		 * Emits a session event with session ID and last sequence number.
		 *
		 * @param enqueue - Enqueue function for scheduling actions
		 * @param event - Init response event containing session details
		 */
		updateWriteSession: enqueueActions(({ enqueue, event }) => {
			assert.ok(event.type === 'writer.stream.response.init')
			assert.ok(event.data)

			enqueue.assign({
				sessionId: event.data.sessionId,
			})

			enqueue.emit(() => ({
				type: 'writer.session',
				sessionId: event.data.sessionId,
				lastSeqNo: event.data.lastSeqNo || 0n,
			}))
		}),

		// ====================================================================
		// MESSAGE PROCESSING ACTIONS
		// ====================================================================

		/**
		 * Sends messages from the buffer to the stream actor.
		 * Handles batching and inflight constraints.
		 *
		 * @param enqueue - Enqueue function for scheduling actions
		 * @param context - State machine context containing buffer and inflight details
		 */
		sendMessages: enqueueActions(({ enqueue, context }) => {
			if (!context.bufferLength) {
				enqueue.emit(() => ({
					type: 'writer.error',
					error: new Error(
						'Internal Error: No messages to send. If you see this error, please report it.'
					),
				}))

				return
			}

			if (context.inflightLength >= context.options.maxInflightCount!) {
				enqueue.emit(() => ({
					type: 'writer.error',
					error: new Error(
						'Internal Error: Max inflight messages limit reached. If you see this error, please report it.'
					),
				}))

				return
			}

			// Calculate batch size and count, respecting max batch and inflight limits
			let batchSize = 0n
			let batchLength = 0

			for (
				let i = context.bufferStart;
				i < context.bufferStart + context.bufferLength;
				i++
			) {
				let message = context.messages[i]!
				let messageSize = BigInt(message.data.length)

				if (
					batchSize + messageSize > MAX_BATCH_SIZE &&
					batchLength > 0
				) {
					break
				}

				if (
					context.inflightLength + batchLength >=
					context.options.maxInflightCount!
				) {
					break
				}

				batchSize += messageSize
				batchLength++
			}

			// Prepare batch and send to stream actor
			let start = context.inflightStart + context.inflightLength
			let batch = context.messages.slice(start, start + batchLength)

			// Create transaction object if exists
			let tx
			if (context.tx) {
				tx = create(TransactionIdentitySchema, {
					id: context.tx.transactionId,
					session: context.tx.sessionId,
				})
			}

			let codec = context.options.codec?.codec || Codec.RAW

			enqueue.sendTo('WriterStream', {
				type: 'writer.stream.request.write',
				data: create(StreamWriteMessage_WriteRequestSchema, {
					...(tx && { tx }),
					codec,
					messages: batch,
				}),
			} satisfies WriterStreamReceiveEvent)

			// Update buffer and inflight windows after sending
			enqueue.assign(() => ({
				bufferSize: context.bufferSize - batchSize,
				bufferStart: context.bufferStart + batchLength,
				bufferLength: context.bufferLength - batchLength,
				inflightSize: context.inflightSize + batchSize,
				inflightLength: context.inflightLength + batchLength,
			}))

			// @ts-ignore
			enqueue({ type: 'log', params: { message: 'WRT | {stats}' } })
		}),
		/**
		 * Acknowledges messages after receiving acknowledgment from the stream actor.
		 * Updates garbage collection metrics.
		 *
		 * @param enqueue - Enqueue function for scheduling actions
		 * @param event - Acknowledgment event containing message details
		 * @param context - State machine context containing inflight details
		 */
		acknowledgeMessages: enqueueActions(({ enqueue, event, check }) => {
			assert.ok(event.type === 'writer.stream.response.write')
			assert.ok(event.data.acks?.length)

			let acks = new Map<bigint, 'skipped' | 'written' | 'writtenInTx'>()
			for (let ack of event.data.acks) {
				acks.set(
					ack.seqNo,
					ack.messageWriteStatus.case as
						| 'skipped'
						| 'written'
						| 'writtenInTx'
				)
			}

			// Emit acknowledgment event with detailed information
			enqueue.emit(() => ({
				type: 'writer.acknowledgments',
				acknowledgments: acks,
			}))

			// Update inflight and garbage metrics based on acknowledgments
			enqueue.assign(({ context }) => {
				let removedSize = 0n
				let removedCount = 0

				// Move acknowledged messages to garbage
				for (
					let i = context.inflightStart;
					i < context.inflightStart + context.inflightLength;
					i++
				) {
					let message = context.messages[i]

					if (message && acks.has(message.seqNo)) {
						removedSize += BigInt(message.data.length)
						removedCount++
					}
				}

				// Update context pointers
				return {
					garbageSize: context.garbageSize + removedSize,
					inflightSize: context.inflightSize - removedSize,
					inflightStart: context.inflightStart + removedCount,
					inflightLength: context.inflightLength - removedCount,
				}
			})

			// @ts-ignore
			if (check({ type: 'shouldReclaimMemory' })) {
				enqueue.assign(({ context }) => {
					let removed = context.messages.splice(
						0,
						context.inflightStart
					)
					let bufferStart = context.bufferStart - removed.length

					// Recalculate bufferSize using sliding window approach:
					// buffer region is messages from bufferStart to bufferStart + bufferLength
					let bufferSize = 0n
					for (
						let i = bufferStart;
						i < bufferStart + context.bufferLength;
						i++
					) {
						let message = context.messages[i]
						if (message) {
							bufferSize += BigInt(message.data.length)
						}
					}

					// Update context pointers
					return {
						messages: context.messages,
						garbageSize: 0n,
						inflightStart: 0,
						bufferSize,
						bufferStart,
					}
				})
			}

			// @ts-ignore
			enqueue({ type: 'log', params: { message: 'ACK | {stats}' } })
		}),

		// ====================================================================
		// BUFFER MANAGEMENT ACTIONS
		// ====================================================================

		// Adds a new message to the buffer, validates payload size, and mutates the array in place for performance.
		enqueueMessage: enqueueActions(({ enqueue, context, event }) => {
			assert.ok(event.type === 'writer.write')
			assert.ok(event.message)

			// Validate payload size against YDB single message limit
			if (event.message.data.length > MAX_PAYLOAD_SIZE) {
				enqueue.emit(() => ({
					type: 'writer.error',
					error: new Error(
						'Internal Error: Payload size exceeds 48MiB limit. If you see this error, please report it.'
					),
				}))

				return
			}

			let createdAt = timestampFromDate(
				event.message.createdAt ?? new Date()
			)
			let metadataItems = Object.entries(
				event.message.metadataItems || {}
			).map(([key, value]) => ({
				key,
				value,
			}))
			let uncompressedSize = BigInt(event.message.data.length)

			let message = create(
				StreamWriteMessage_WriteRequest_MessageDataSchema,
				{
					data: event.message.data,
					seqNo: event.message.seqNo,
					createdAt,
					metadataItems,
					uncompressedSize,
				}
			)

			// Mutate messages array in place for performance (avoids new array allocation)
			context.messages.push(message)

			enqueue.assign(({ context }) => ({
				bufferSize:
					context.bufferSize + BigInt(event.message.data.length),
				bufferLength: context.bufferLength + 1,
			}))

			//@ts-ignore
			enqueue({ type: 'log', params: { message: 'ENQ | {stats}' } })
		}),

		// ====================================================================
		// ERROR HANDLING AND RETRY ACTIONS
		// ====================================================================

		// Resets retry attempts counter after a successful connection.
		resetAttempts: assign({
			attempts: 0,
		}),
		// Increments retry attempts counter for exponential backoff.
		incrementAttempts: assign({
			attempts: ({ context }) => context.attempts + 1,
		}),
		// Records the last error received from the stream for error handling and reporting.
		recordError: assign({
			lastError: ({ event }) => {
				assert.ok(event.type === 'writer.stream.error')
				return event.error
			},
		}),
		// Emits an error event to the user after a non-retryable error.
		reportError: enqueueActions(({ enqueue, context }) => {
			assert.ok(
				context.lastError,
				'lastError must be set before reporting'
			)

			enqueue.emit(() => ({
				type: 'writer.error',
				error: context.lastError,
			}))
		}),

		// ====================================================================
		// CLEANUP AND RESOURCE MANAGEMENT ACTIONS
		// ====================================================================

		/**
		 * Releases resources held by the state machine.
		 * Used during shutdown or error handling.
		 */
		releaseResources: assign(() => {
			return {
				messages: [],
				bufferStart: 0,
				bufferLength: 0,
				inflightStart: 0,
				inflightLength: 0,
				bufferSize: 0n,
				inflightSize: 0n,
				garbageSize: 0n,
			}
		}),
	},

	// ========================================================================
	// TIMING AND DELAYS
	// ========================================================================

	delays: {
		retryDelay: ({ context }) => {
			// Calculate exponential backoff delay with jitter
			let baseDelay = 50 // Base delay in milliseconds
			let maxDelay = 5000 // Maximum delay in milliseconds
			let delay = Math.min(
				baseDelay * Math.pow(2, context.attempts),
				maxDelay
			)

			// Add jitter to avoid synchronized retries
			let jitter = Math.random() * 0.1 // ±10%
			delay = delay * (1 + jitter)

			// Return the rounded delay value
			return Math.round(delay)
		},
		flushInterval: ({ context }) => {
			// Interval for background flush of buffered messages
			return context.options.flushIntervalMs!
		},
		gracefulShutdownTimeout: ({ context }) => {
			// Timeout for forced shutdown if graceful close takes too long
			return context.options.gracefulShutdownTimeoutMs!
		},
	},

	// ========================================================================
	// GUARD CONDITIONS
	// ========================================================================

	guards: {
		allMessagesSent: ({ context }) => {
			let bufferEmpty = context.bufferLength === 0
			let inflightEmpty = context.inflightLength === 0

			return bufferEmpty && inflightEmpty
		},
		bufferFullAndCanSend: ({ context }) => {
			let bufferFull =
				context.bufferSize >= context.options.maxBufferBytes!
			let inflightNotFull =
				context.inflightLength < context.options.maxInflightCount!

			return bufferFull && inflightNotFull
		},
		hasMessagesAndCanSend: ({ context }) => {
			let bufferNotEmpty = context.bufferLength > 0
			let inflightNotFull =
				context.inflightLength < context.options.maxInflightCount!

			return bufferNotEmpty && inflightNotFull
		},
		retryableError: ({ context }) => {
			if (context.lastError) {
				return isRetryableError(context.lastError, true)
			}

			return false
		},
		nonRetryableError: ({ context }) => {
			if (context.lastError) {
				return !isRetryableError(context.lastError, true)
			}

			return false
		},
		shouldReclaimMemory: ({ context }) => {
			let maxGarbageSize =
				context.options.garbageCollection!.maxGarbageSize!
			let maxGarbageCount =
				context.options.garbageCollection!.maxGarbageCount!

			if (context.inflightStart > maxGarbageCount) {
				return true
			}

			if (context.garbageSize > maxGarbageSize) {
				return true
			}

			return false
		},
	},
})

// ============================================================================
// WRITER STATE MACHINE INSTANCE
// ============================================================================

/**
 * State machine for TopicWriter lifecycle management.
 *
 * Handles the complete lifecycle of a YDB Topic writer including:
 * - Connection establishment and session initialization
 * - Message batching and flow control
 * - Graceful shutdown with pending message flush
 * - Error handling with exponential backoff retry
 * - Resource cleanup and memory management
 *
 * State Transitions:
 * - connecting: Establish gRPC stream connection
 * - connected: Initialize write session with YDB
 * - ready: Idle state, waiting for messages or flush triggers
 * - writing: Actively sending message batches
 * - flushing: Manual flush, waiting for all acks
 * - closing: Graceful shutdown, flushing pending messages
 * - errored: Error state with retry logic
 * - closed: Final state with all resources released
 */
export const WriterMachine = writerMachineFactory.createMachine({
	id: 'WriterMachine',

	initial: 'idle',

	// ========================================================================
	// CONTEXT INITIALIZATION
	// ========================================================================

	context: ({
		input,
	}: {
		input: { driver: Driver; options: TopicWriterOptions }
	}) => {
		let { driver, options } = input

		// Set up defaults like in original writer
		options.codec ??= defaultCodecMap.get(Codec.RAW)!
		options.maxBufferBytes ??= 1024n * 1024n * 256n
		options.flushIntervalMs ??= 1000
		options.maxInflightCount ??= 1000
		options.updateTokenIntervalMs ??= 60_000
		options.gracefulShutdownTimeoutMs ??= 30_000

		// Validate and normalize garbage collection settings
		options.garbageCollection ??= {}
		options.garbageCollection.forceGC ??= false

		let maxGarbageCount = (options.garbageCollection.maxGarbageCount ??=
			DEFAULT_GARBAGE_COUNT_THRESHOLD)
		if (maxGarbageCount <= 0) {
			throw new Error(
				`garbageCollection.maxGarbageCount must be positive, got: ${maxGarbageCount}`
			)
		}

		let maxGarbageSize = (options.garbageCollection.maxGarbageSize ??=
			DEFAULT_GARBAGE_SIZE_THRESHOLD)
		if (maxGarbageSize < 0n) {
			throw new Error(
				`garbageCollection.maxGarbageSize must be non-negative, got: ${maxGarbageSize}`
			)
		}

		return {
			dbg: loggers.topic.extend('writer').extend(options.producerId),
			driver,
			options,
			attempts: 0,

			producerId: options.producerId,
			...(options.partitionId && { partitionId: options.partitionId }),
			...(options.messageGroupId && {
				messageGroupId: options.messageGroupId,
			}),

			// Single array approach with sliding window
			messages: [],
			bufferStart: 0,
			bufferLength: 0,
			inflightStart: 0,
			inflightLength: 0,

			// Only sizes need to be tracked for performance
			bufferSize: 0n,
			inflightSize: 0n,
			garbageSize: 0n,

			...(options.tx && { tx: options.tx }),
		} satisfies WriterContext
	},

	// ========================================================================
	// TOP-LEVEL EVENT HANDLERS
	// ========================================================================

	// Top-level event handlers
	on: {
		'writer.close': {
			target: '.closing',
			actions: [log('CLS | {topicPath}')],
		},
		'writer.destroy': {
			// Force close, skip graceful shutdown
			target: '.closed',
			actions: [log('DST | {topicPath}')],
		},
		'writer.stream.error': {
			// Enter error state on stream error
			target: '.errored',
			actions: ['recordError', log('ERR | {lastError}')],
		},
	},

	// ========================================================================
	// STATE DEFINITIONS
	// ========================================================================

	states: {
		idle: {
			always: {
				target: 'connecting',
				actions: [log('INT | {topicPath}')],
			},
		},
		/**
		 * Connecting state: Establishes connection to the topic stream.
		 * - Buffers incoming messages while connecting.
		 * - Transitions to `connected` once the stream is ready.
		 */
		connecting: {
			entry: ['createConnection'],
			on: {
				'writer.write': {
					// Buffer message for later delivery; connection is not yet established
					actions: ['enqueueMessage'],
				},
				'writer.stream.start': {
					// Connection established, transition to connected state
					target: 'connected',
				},
			},
		},

		/**
		 * Connected state: Initializes the write session.
		 * - Buffers incoming messages.
		 * - Transitions to `ready` once the session is established.
		 */
		connected: {
			entry: ['createWriteSession', log('CON | {stats}')],
			on: {
				'writer.write': {
					// Buffer message while session is initializing; will be sent after session is ready
					actions: ['enqueueMessage'],
				},
				'writer.stream.close': {
					// Stream closed unexpectedly, attempt to reconnect
					target: 'connecting',
				},
				'writer.stream.response.init': {
					// Session established, transition to ready state for message sending
					target: 'ready',
					actions: [
						'resetAttempts',
						'updateWriteSession',
						log('SES | {sessionId}'),
					],
				},
			},
		},

		/**
		 * Ready state: Idle, waiting for buffer to fill or flush interval.
		 * - Automatically transitions to `writing` when buffer is full and can send messages.
		 * - Handles manual flush requests.
		 */
		ready: {
			always: {
				// Send messages if buffer is full and can send
				guard: 'bufferFullAndCanSend',
				actions: ['sendMessages'],
			},
			after: {
				// Periodic flush if there are messages and can send
				flushInterval: {
					guard: 'hasMessagesAndCanSend',
					actions: ['sendMessages'],
				},
			},
			on: {
				'writer.write': {
					// Buffers new message
					actions: ['enqueueMessage'],
				},
				'writer.flush': {
					// Manual flush request transitions to flushing only if there are messages
					target: 'flushing',
				},
				'writer.stream.close': {
					// Reconnect if stream closes
					target: 'connecting',
				},
				'writer.stream.response.write': {
					// Processes acknowledgments from the stream
					actions: ['acknowledgeMessages'],
				},
			},
		},

		/**
		 * Flushing state: Sends all buffered messages and waits for acknowledgments.
		 * - Blocks new writes during flush to avoid infinite loops.
		 * - Exits only when all messages are sent and acknowledged.
		 */
		flushing: {
			always: [
				{
					// Only exit when all sent/acked
					guard: 'allMessagesSent',
					target: 'ready',
				},
				{
					// If messages remain, continue flushing
					guard: 'hasMessagesAndCanSend',
					target: 'flushing',
					reenter: true,
					actions: ['sendMessages'],
				},
			],
			after: {
				// Periodic flush if messages remain and can send
				flushInterval: {
					target: 'flushing',
					reenter: true,
				},
			},
			on: {
				'writer.stream.response.write': {
					// Acknowledges messages that have been successfully written
					actions: ['acknowledgeMessages'],
				},
			},
		},

		/**
		 * Closing state: Performs graceful shutdown by flushing all messages before closing.
		 * - Ensures all messages are sent and acknowledged before closing.
		 * - Includes timeout mechanism to force close if graceful shutdown takes too long.
		 */
		closing: {
			always: [
				{
					// Only close when all sent/acked
					target: 'closed',
					guard: 'allMessagesSent',
					actions: ['closeConnection'],
				},
				{
					// If flush is still in progress, stay in closing
					guard: 'hasMessagesAndCanSend',
					target: 'closing',
					reenter: true,
					actions: ['sendMessages'],
				},
			],
			after: {
				// Periodic flush if messages remain and can send
				flushInterval: {
					guard: 'hasMessagesAndCanSend',
					target: 'closing',
					reenter: true,
				},
				// Force close after graceful shutdown timeout
				gracefulShutdownTimeout: {
					target: 'closed',
					actions: ['closeConnection'],
				},
			},
			on: {
				'writer.stream.response.write': {
					target: 'closing',
					reenter: true,
					actions: ['acknowledgeMessages'],
				},
			},
		},

		/**
		 * Errored state: Handles errors and decides whether to retry or close.
		 * - Closes the connection immediately upon entering this state.
		 * - Transitions to `closed` for non-retryable errors.
		 * - Attempts reconnection for retryable errors after a delay.
		 * - Buffers incoming messages even while in error state.
		 */
		errored: {
			entry: ['closeConnection'],
			always: [
				{
					// If error is not retryable, report and close
					guard: 'nonRetryableError',
					target: 'closed',
					actions: ['reportError'],
				},
			],
			after: {
				retryDelay: {
					// Retry connection after delay if error is retryable
					guard: 'retryableError',
					target: 'connecting',
					actions: ['resetAttempts'],
				},
			},
			on: {
				'writer.write': {
					// Buffers messages even in error state
					actions: ['enqueueMessage'],
				},
			},
		},

		/**
		 * Closed state: Final state where all resources are released.
		 * - Ensures the connection is closed and resources are cleaned up.
		 * - No further transitions occur from this state.
		 */
		closed: {
			// All resources are released in this final state
			type: 'final',
			entry: [
				'closeConnection',
				'releaseResources',
				log('FIN | {stats}'),
			],
		},
	},
})
