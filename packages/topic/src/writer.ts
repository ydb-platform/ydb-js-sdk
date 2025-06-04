import { EventEmitter } from "node:events";
import { nextTick } from "node:process";

import { create, toJson } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { StatusIds_StatusCode } from "@ydbjs/api/operation";
import { Codec, type StreamWriteMessage_FromClient, StreamWriteMessage_FromClientSchema, type StreamWriteMessage_FromServer, StreamWriteMessage_FromServerSchema, type StreamWriteMessage_WriteRequest_MessageData, StreamWriteMessage_WriteRequest_MessageDataSchema, TopicServiceDefinition } from "@ydbjs/api/topic";
import type { Driver } from "@ydbjs/core";
import { YDBError } from "@ydbjs/error";
import { type RetryConfig, retry } from "@ydbjs/retry";
import { backoff, combine, jitter } from "@ydbjs/retry/strategy";

import { AsyncEventEmitter } from "./aee.js";
import { dbg } from "./dbg.js";

const UPDATE_TOKEN_INTERVAL_MS = 60 * 1000; // Default update token interval in milliseconds
const FLUSH_INTERVAL_MS = 1000; // Default flush interval in milliseconds
const MAX_INFLIGHT_COUNT = 1000n; // Default maximum in-flight messages count
const MAX_BUFFER_BYTES = 256n * 1024n * 1024n; // Maximum buffer size in bytes, default is 256MiB
const MAX_PAYLOAD_SIZE = 8n * 1024n * 1024n; // Maximum compressed (if compression is enabled) payload size, default is 8MiB
const MAX_BATCH_SIZE = 48n * 1024n * 1024n; // Maximum batch size in bytes, default is 48MiB
const MIN_RAW_SIZE = 1024n; // Minimum raw size for compression

type FromClientEmitterMap = {
	"message": [StreamWriteMessage_FromClient]
	"error": [unknown]
	"end": []
}

type FromServerEmitterMap = {
	"message": [StreamWriteMessage_FromServer]
	"error": [unknown]
	"end": []
}

export type onAcknowledgeCallback = (
	committedOffset: bigint,
) => void

export type TopicWriterOptions<Payload = Uint8Array> = {
	// Path to the topic to write to.
	// Example: "/Root/my-topic"
	topic: string
	// The producer name to use for writing messages.
	// If not provided, a random producer name will be generated.
	// If provided, the producer name will be used to identify the writer.
	producer?: string
	// Automatically get the last sequence number of the topic before starting to write messages.
	// If not provided, the writer will not get the last sequence number.
	// This is useful to ensure that the writer starts writing messages after the last message in the topic.
	// If true, the writer will get the last sequence number of the topic before starting to write messages.
	getLastSeqNo?: boolean
	// Allow duplicates in the topic, default is false.
	// If true, the writer will write messages without producerId.
	allowDuplicates?: boolean
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
	// If not provided, the default is 1000 messages.
	maxInflightCount?: bigint
	// The Interval in milliseconds to flush the buffer automatically.
	// If not provided, the writer will not flush the buffer automatically.
	// This is useful to ensure that the writer does not hold too many messages in memory.
	flushIntervalMs?: number
	// Compression options for the payload.
	compression?: {
		codec: Codec,
		// Minimum raw size to compress, if the payload is smaller than this size, it will not be compressed.
		// This is useful to avoid compressing small payloads that do not benefit from compression.
		// Default is 1024 bytes.
		minRawSize?: bigint
		// Custom compression function that can be used to compress the payload before sending it to the topic.
		// This function should return a compressed Uint8Array payload.
		// If not provided, the default compression function will be used.
		// The default compression function will use the codec specified in the options.
		// If the codec is Codec.RAW, the payload will not be compressed.
		compress?(payload: Uint8Array): Uint8Array | Promise<Uint8Array>
	}
	// Custom encoding function that can be used to transform the payload before compressing or sending it to the topic.
	encode?(payload: Payload): Uint8Array

	// Callback that is called when writer receives an acknowledgment for a message.
	onAck?: (seqNo: bigint, status?: 'skipped' | 'written' | 'writtenInTx') => void
}

export class TopicWriter<Payload = Uint8Array> implements Disposable, AsyncDisposable {
	#driver: Driver;
	#options: TopicWriterOptions<Payload>;
	#disposed = false;
	#initialized = Promise.withResolvers<void>();

	#controller: AbortController = new AbortController();
	#flushInterval: NodeJS.Timeout
	#updateTokenTicker: NodeJS.Timeout

	// Last sequence number of the topic,
	// used to ensure that the writer starts writing messages after the last message in the topic.
	#lastSeqNo: bigint = 0n;
	// Flag to indicate if the sequence number is provided by the user.
	#isSeqNoProvided: boolean = false;

	// Map of sequence numbers to messages that are currently in the buffer.
	// This is used to keep track of messages that are not yet sent to the server.
	#buffer: Map<bigint, StreamWriteMessage_WriteRequest_MessageData> = new Map(); // seqNo -> message
	#bufferSize: bigint = 0n;

	// In-flight messages that are not yet acknowledged.
	#inflight: Set<bigint> = new Set(); // seqNo

	#fromClientEmitter = new EventEmitter<FromClientEmitterMap>();
	#fromServerEmitter = new EventEmitter<FromServerEmitterMap>();

	// pending acks that are not yet resolved.
	#pendingAcks: Map<bigint, PromiseWithResolvers<void>> = new Map(); // seqNo -> PromiseWithResolvers

	/**
	 * Creates a new TopicWriter instance.
	 * @param driver - The YDB driver instance to use for communication with the YDB server.
	 * @param options - Options for the topic writer, including topic path, consumer name, and optional callbacks.
	 */
	constructor(driver: Driver, options: TopicWriterOptions<Payload>) {
		this.#driver = driver;
		this.#options = { ...options };

		if (!options.encode) {
			// Default encode function that returns the payload as is.
			this.#options.encode = (payload: Payload) => payload as Uint8Array;
		}

		if (!options.producer) {
			// Generate a random producer name if not provided.
			let processId = process.pid;
			let currentTime = new Date().getTime();
			let randomSuffix = Math.floor(Math.random() * 1000000);
			this.#options.producer = `producer-${processId}-${currentTime}-${randomSuffix}`;
		}

		if (options.getLastSeqNo === false) {
			this.#options.getLastSeqNo = false;
		} else {
			// Default to true if not provided.
			this.#options.getLastSeqNo = true;
		}

		if (options.allowDuplicates) {
			this.#options.producer = undefined; // If duplicates are allowed, producerId is not used.
			this.#options.getLastSeqNo = false; // If duplicates are allowed, we don't need to get the last sequence number.
		}

		// Start consuming the stream immediately.
		void this.#consumeStream()

		/**
		 * Periodically updates the token by emitting an updateTokenRequest message.
		 */
		this.#updateTokenTicker = setInterval(async () => {
			this.#fromClientEmitter.emit('message', create(StreamWriteMessage_FromClientSchema, {
				clientMessage: {
					case: 'updateTokenRequest',
					value: {
						token: await this.#driver.token
					},
				}
			}))
		}, this.#options.updateTokenIntervalMs || UPDATE_TOKEN_INTERVAL_MS)

		// Unref the ticker to allow the process to exit if this is the only active timer.
		this.#updateTokenTicker.unref()

		/**
		 * Periodically flushes the buffer to the server.
		 * This is useful to ensure that messages are sent to the server even if the buffer is not full.
		 * If the buffer is not empty, it will send the messages to the server.
		 * If the buffer is empty, it will skip the flush.
		 */
		this.#flushInterval = setInterval(async () => {
			if (this.#disposed) {
				dbg('flush interval triggered, but writer is disposed, skipping flush');
				return;
			}

			if (this.#buffer.size > 0) {
				dbg('flush interval triggered, flushing buffer with %d messages', this.#buffer.size);
				await this.flush(AbortSignal.timeout(this.#options.flushIntervalMs || FLUSH_INTERVAL_MS));
			} else {
				dbg('flush interval triggered, but buffer is empty, nothing to flush');
			}
		}, this.#options.flushIntervalMs || FLUSH_INTERVAL_MS)

		// Unref the flush interval to allow the process to exit if this is the only active timer.
		this.#flushInterval.unref()

		// Log all messages from client.
		// This is useful for debugging purposes to see what messages are sent to the server.

		let dbgrpc = dbg.extend('grpc')
		this.#fromClientEmitter.on('message', (msg) => {
			dbgrpc('%s %o', msg.$typeName, toJson(StreamWriteMessage_FromClientSchema, msg))
		})

		// Log all messages from server.
		this.#fromServerEmitter.on('message', (msg) => {
			dbgrpc('%s %o', msg.$typeName, toJson(StreamWriteMessage_FromServerSchema, msg))
		})

		// Handle messages from server.
		this.#fromServerEmitter.on('message', async (message) => {
			if (this.#disposed) {
				dbg('error: receive "%s" after dispose', message.serverMessage.value?.$typeName)
				return
			}

			if (message.serverMessage.case === 'initResponse') {
				dbg(`start write session with identifier: %s, partition ID: %s, last sequence number: %s, supported compression codecs: %o`,
					message.serverMessage.value.sessionId,
					message.serverMessage.value.partitionId,
					message.serverMessage.value.lastSeqNo,
					message.serverMessage.value.supportedCodecs
				);

				this.#initialized.resolve(); // Mark the writer as initialized

				// Store the last sequence number from the server.
				this.#lastSeqNo = message.serverMessage.value.lastSeqNo;
				dbg('updating last sequence number to %s', this.#lastSeqNo);
			}

			if (message.serverMessage.case === 'writeResponse') {
				dbg('received write response with %d acks', message.serverMessage.value.acks.length);

				// Process each acknowledgment in the response.
				// This will resolve the pending ack promises and remove the messages from the buffer.
				for (let ack of message.serverMessage.value.acks) {
					dbg('acknowledged message %s with status %s', ack.seqNo, ack.messageWriteStatus.case);
					this.#options.onAck?.(ack.seqNo, ack.messageWriteStatus.case);

					// Remove the acknowledged message from the buffer.
					let message = this.#buffer.get(ack.seqNo);
					if (message) {
						this.#buffer.delete(ack.seqNo);
						this.#bufferSize -= BigInt(message.data.length);

						dbg('removed message %s from buffer', ack.seqNo);

						// Resolve the pending ack promise for this sequence number.
						let pendingAck = this.#pendingAcks.get(ack.seqNo);
						if (pendingAck) {
							dbg('resolving pending ack for message %s', ack.seqNo);
							pendingAck.resolve();
							this.#pendingAcks.delete(ack.seqNo);
						}

						// Decrease the in-flight count.
						this.#inflight.delete(ack.seqNo);
						dbg('decreased in-flight count to %d', this.#inflight.size);
					}
				}

				// After processing all acks, try to send more messages from the buffer.
				this.#sendBufferedMessages();
			}
		});
	}

	/**
	 * Asynchronously consumes events from the stream and emits corresponding messages or errors.
	 * Emits 'message' event for successful server messages, 'error' event for unsuccessful statuses or caught errors,
	 * and 'end' event when the stream ends.
	 *
	 * @returns A promise that resolves when the stream consumption is complete.
	 */
	async #consumeStream(): Promise<void> {
		if (this.#disposed) {
			return
		}

		let signal = this.#controller.signal
		await this.#driver.ready(signal)

		let retryConfig: RetryConfig = {
			signal,
			budget: Infinity,
			strategy: combine(jitter(50), backoff(50, 5000)),
			retry(error) {
				dbg('retrying stream read due to %O', error);
				return true;
			},
		}

		try {
			// TODO: handle user errors (for example tx errors). Ex: use abort signal
			await retry(retryConfig, async () => {
				this.#initialized = Promise.withResolvers<void>();

				using outgoing = new AsyncEventEmitter<StreamWriteMessage_FromClient>(this.#fromClientEmitter, 'message')

				let stream = this.#driver
					.createClient(TopicServiceDefinition)
					.streamWrite(outgoing, { signal });

				nextTick(() => {
					dbg('start consuming topic write stream for producer %s on topic %s', this.#options.producer, this.#options.topic);

					this.#fromClientEmitter.emit('message', create(StreamWriteMessage_FromClientSchema, {
						clientMessage: {
							case: 'initRequest',
							value: {
								path: this.#options.topic,
								producerId: this.#options.producer,
								getLastSeqNo: this.#options.getLastSeqNo,
							}
						}
					}))
				})

				for await (const event of stream) {
					this.#controller.signal.throwIfAborted();

					if (event.status !== StatusIds_StatusCode.SUCCESS) {
						let error = new YDBError(event.status, event.issues)
						dbg('received error from server: %s', error.message);
						throw error;
					}

					this.#fromServerEmitter.emit('message', event);
				}
			});
		} catch (error) {
			dbg('error: %O', error);

			this.#fromServerEmitter.emit('error', error);
		} finally {
			this.#fromServerEmitter.emit('end');
		}
	}

	/**
	 * Send messages from the buffer to the server
	 * until the maximum in-flight count is reached or the buffer is empty.
	 */
	#sendBufferedMessages(): void {
		if (this.#disposed) {
			dbg('sendBufferedMessages called, but writer is disposed, skipping');
			return;
		}

		if (this.#buffer.size === 0) {
			dbg('sendBufferedMessages called, but buffer is empty, nothing to send');
			return;
		}

		if (this.#inflight.size >= (this.#options.maxInflightCount || MAX_INFLIGHT_COUNT)) {
			dbg('sendBufferedMessages called, but in-flight count is at maximum (%d).', this.#inflight.size);
			return;
		}

		let iterator = this.#buffer.values()
		let messagesToSend: StreamWriteMessage_WriteRequest_MessageData[] = [];

		// Collect messages from the buffer until we reach the maximum in-flight count or the buffer is empty.
		while (this.#inflight.size + messagesToSend.length < (this.#options.maxInflightCount || MAX_INFLIGHT_COUNT)) {
			let nextMessage = iterator.next();
			if (nextMessage.done) {
				break; // No more messages in the buffer to send.
			}

			if (this.#inflight.has(nextMessage.value.seqNo)) {
				break; // Skip messages that are already pending acknowledgment.
			}

			messagesToSend.push(nextMessage.value); // Add the message to the list of messages to send.
			this.#inflight.add(nextMessage.value.seqNo); // Mark the message as in-flight.
		}

		if (!messagesToSend.length) {
			dbg('sendBufferedMessages called, but no messages to send, in-flight count: %d', this.#inflight.size);
			return; // No messages to send, exit early.
		}

		// Send the buffered messages in batches to prevent hitting YDB message size limits
		while (messagesToSend.length > 0) {
			let batch: StreamWriteMessage_WriteRequest_MessageData[] = [];
			let batchSize = 0n;

			// Build batch until size limit or no more messages
			while (messagesToSend.length > 0) {
				const message = messagesToSend[0];

				// Check if adding this message would exceed the batch size limit
				if (batchSize + BigInt(message.data.length) > MAX_BATCH_SIZE) {
					// If the batch already has messages, send it
					if (batch.length > 0) break;

					// If this is a single message exceeding the limit, we still need to send it
					dbg('large message of size %d bytes exceeds threshold, sending in its own batch', message.data.length);
					batch.push(messagesToSend.shift()!);
					break;
				}

				// Add message to current batch
				batch.push(messagesToSend.shift()!);
				batchSize += BigInt(message.data.length);
			}

			// Send the batch
			if (batch.length > 0) {
				dbg('sending batch of %d messages (%d bytes)', batch.length, batchSize);
				this.#fromClientEmitter.emit('message', create(StreamWriteMessage_FromClientSchema, {
					clientMessage: {
						case: 'writeRequest',
						value: {
							messages: batch,
							codec: this.#options.compression?.codec || Codec.RAW,
						}
					}
				}));
			}
		}
	}

	/**
	 * Writes a message to the topic.
	 *
	 * This method does not send the message immediately, it only adds it to the buffer.
	 * If you want to send the messages immediately, you can call the `flush` method.
	 *
	 * Returns a promise that resolves when the message is successfully written to the topic.
	 *
	 * @param input The TopicMessage to write to the topic.
	 * @param input.payload The payload of the message to write.
	 * @param input.seqNo The sequence number of the message, if not provided, it will be automatically generated.
	 * @param input.createdAt The creation date of the message, if not provided, the current date will be used.
	 * @param input.metadataItems Optional metadata items to attach to the message.
	 * @param input.metadataItems.key The key of the metadata item.
	 * @param input.metadataItems.value The value of the metadata item.
	 * @returns {Promise<void>} A promise that resolves when the message is successfully written to the topic.
	 */
	async write(payload: Payload | Uint8Array, options: { seqNo?: bigint, createdAt?: Date, metadataItems?: Record<string, Uint8Array> } = {}): Promise<void> {
		// Check if the writer has been disposed, cannot write with disposed writer
		if (this.#disposed) {
			throw new Error('Writer is disposed');
		}

		let abort = Promise.withResolvers<void>();
		this.#controller.signal?.addEventListener('abort', () => abort.resolve(), { once: true });

		await Promise.race([
			abort.promise,
			this.#initialized.promise,
		]); // Ensure the writer is initialized before writing messages

		if (this.#disposed) {
			dbg('write called, but writer is disposed, skipping write');
			throw new Error('Writer is disposed');
		}

		if (this.#controller.signal.aborted) {
			dbg('write called, but signal is aborted, skipping write');
			throw new Error('Write aborted');
		}

		if (options.seqNo) {
			this.#isSeqNoProvided = true; // Mark that a sequence number is provided by the user
		} else if (this.#isSeqNoProvided) {
			throw new Error('Sequence number is required when writing messages with a provided sequence number. If you want to use auto-generated sequence numbers, do not provide seqNo in the input.');
		}

		if (this.#bufferSize > (this.#options.maxBufferBytes || MAX_BUFFER_BYTES)) {
			dbg('buffer size exceeded, triggering flush');
			await this.flush();
		}

		let data = payload instanceof Uint8Array ? payload : this.#options.encode!(payload);
		let seqNo = options.seqNo ?? (this.#lastSeqNo + 1n);
		let createdAt = timestampFromDate(options.createdAt ?? new Date());
		let uncompressedSize = BigInt(data.length);
		let metadataItems = options.metadataItems || {};

		if (this.#options.compression) {
			// If compression is enabled, check if the payload should be compressed
			if (this.#options.compression.codec !== Codec.RAW && data.length >= (this.#options.compression.minRawSize || MIN_RAW_SIZE)) {
				// Use custom compression function if provided, otherwise use default compression
				data = this.#options.compression.compress
					? await this.#options.compression.compress(data)
					: data; // Default to raw if no compression is applied
			} else {
				// If the payload is smaller than the minimum size, do not compress it
				this.#options.compression.codec = Codec.RAW;
			}
		}

		// Validate the payload size, it should not exceed MAX_PAYLOAD_SIZE
		// This is a YDB limitation for single message size.
		if (data.length > MAX_PAYLOAD_SIZE) {
			throw new Error(`Payload size exceeds ${Number(MAX_PAYLOAD_SIZE / (1024n * 1024n))}MiB limit.`);
		}

		let message = create(StreamWriteMessage_WriteRequest_MessageDataSchema, {
			data,
			seqNo,
			createdAt,
			uncompressedSize,
			metadataItems: Object.entries(metadataItems).map(([key, value]) => ({ key, value }))
		});

		this.#buffer.set(seqNo, message); // Store the message in the buffer
		this.#bufferSize += BigInt(data.length);

		this.#lastSeqNo = seqNo; // Update the last sequence number

		dbg('added message %s to buffer, size: %d bytes, total buffer size: %d bytes', seqNo, data.length, this.#bufferSize);

		let pendingAck = Promise.withResolvers<void>()
		this.#pendingAcks.set(seqNo, pendingAck);

		return pendingAck.promise
	}

	/**
	 * Flushes the buffer, sending all buffered messages to the server and waiting for acknowledgment.
	 *
	 * This method tracks both buffered messages and in-flight messages, ensuring all are properly
	 * acknowledged before returning. It will actively send messages from the buffer while respecting
	 * the maximum in-flight message limit.
	 *
	 * If the buffer is empty, this method resolves immediately. If new messages are added to the buffer
	 * while flushing is in progress, they may also be sent as part of this flush operation.
	 *
	 * @param signal - Optional AbortSignal to cancel the flush operation. If aborted, this method
	 * will reject with an error and stop waiting for acknowledgments.
	 * @returns {Promise<void>} A promise that resolves when all messages have been acknowledged by the server.
	 * @throws {Error} If the writer is disposed or if the abort signal is triggered.
	 */
	async flush(signal?: AbortSignal): Promise<void> {
		// Check if the writer has been disposed, cannot flush with disposed writer
		if (this.#disposed) {
			throw new Error('Writer is disposed');
		}

		if (signal?.aborted) {
			dbg('flush called, but signal is aborted, skipping flush');
			throw new Error('Flush aborted');
		}

		if (!this.#buffer.size) {
			dbg('flush called, but buffer is empty, nothing to flush');
			return;
		}

		let abort = Promise.withResolvers<void>();
		signal?.addEventListener('abort', () => abort.resolve(), { once: true });

		dbg('flushing writer, waiting for %d messages in buffer and %d in-flight messages', this.#buffer.size, this.#inflight.size);
		while (this.#buffer.size > 0 || this.#inflight.size > 0) {
			// If there are messages in the buffer, send them to the server.
			if (this.#buffer.size > 0) {
				this.#sendBufferedMessages();
			}

			dbg('waiting for %d pending acks', this.#pendingAcks.size);

			// Wait for all pending acks to be resolved before flushing.
			// eslint-disable-next-line no-await-in-loop
			await Promise.race([
				abort.promise,
				Promise.all(Array.from(this.#pendingAcks.values()).map(pendingAck => pendingAck.promise)),
			])

			if (signal?.aborted) {
				dbg('flush aborted, stopping flush operation');
				throw new Error('Flush aborted');
			}

			if (this.#disposed) {
				dbg('during flush, writer is disposed, stopping flush operation');
				throw new Error('Writer is disposed');
			}
		}

		dbg('flush complete, all messages acknowledged');
	}

	/**
	 * Disposes the TopicReader instance, cleaning up resources and aborting the stream.
	 * NB: May data loss if there are unacknowledged messages in the buffer.
	 * It is recommended to call `flush` before disposing to ensure all messages are sent and acknowledged.
	 * After calling this method, the TopicReader instance should not be used anymore.
	 */
	dispose() {
		if (this.#disposed) {
			return; // Already disposed, nothing to do
		}

		this.#disposed = true;
		dbg('disposing TopicWriter for topic %s', this.#options.topic);

		// Abort the stream and remove all listeners
		this.#fromClientEmitter.removeAllListeners()
		this.#fromServerEmitter.removeAllListeners()

		for (let pendingAck of this.#pendingAcks.values()) {
			pendingAck.reject(new Error('Writer is disposed'));
		}

		this.#pendingAcks.clear();
		this.#buffer.clear();
		this.#bufferSize = 0n;
		this.#inflight.clear();
		dbg('cleared buffer and in-flight messages');

		clearInterval(this.#updateTokenTicker)
		clearInterval(this.#flushInterval)

		this.#controller.abort()
	}

	/**
	 * Disposes the TopicWriter instance synchronously, cleaning up resources and aborting the stream.
	 * NB: May data loss if there are unacknowledged messages in the buffer.
	 * It is recommended to call `flush` before disposing to ensure all messages are sent and acknowledged.
	 */
	[Symbol.dispose]() {
		this.dispose()
	}

	/**
	 * Disposes the TopicWriter instance asynchronously, ensuring all messages are flushed before disposing.
	 * @returns A promise that resolves when the writer is disposed and all messages are flushed.
	 * @throws Error if the writer is already disposed or if the flush operation is aborted.
	 */
	async [Symbol.asyncDispose]() {
		if (this.#disposed) {
			return; // Already disposed, nothing to do
		}

		this.#disposed = true;
		dbg('async disposing TopicWriter for topic %s', this.#options.topic);

		await this.#initialized.promise; // Ensure the writer is initialized before disposing
		await this.flush(); // Ensure all messages are flushed before disposing

		this.dispose(); // Call the dispose method to clean up resources
	}
}
