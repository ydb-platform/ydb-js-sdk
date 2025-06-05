import * as assert from "node:assert";
import { EventEmitter, once } from "node:events";
import { nextTick } from "node:process";

import { create, protoInt64, toJson } from "@bufbuild/protobuf";
import { type Duration, DurationSchema, type Timestamp, timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { StatusIds_StatusCode } from "@ydbjs/api/operation";
import { Codec, type OffsetsRange, OffsetsRangeSchema, type StreamReadMessage_CommitOffsetRequest_PartitionCommitOffset, StreamReadMessage_CommitOffsetRequest_PartitionCommitOffsetSchema, type StreamReadMessage_FromClient, StreamReadMessage_FromClientSchema, type StreamReadMessage_FromServer, StreamReadMessage_FromServerSchema, type StreamReadMessage_InitRequest_TopicReadSettings, StreamReadMessage_InitRequest_TopicReadSettingsSchema, type StreamReadMessage_ReadResponse, TopicServiceDefinition } from "@ydbjs/api/topic";
import type { Driver } from "@ydbjs/core";
import { YDBError } from "@ydbjs/error";
import { type RetryConfig, retry } from "@ydbjs/retry";
import { backoff, combine, jitter } from "@ydbjs/retry/strategy";
import type { StringValue } from "ms";
import ms from "ms";

import { AsyncEventEmitter } from "./aee.js";
import { dbg } from "./dbg.js";
import { type TopicMessage } from "./message.js";
import { TopicPartitionSession } from "./partition-session.js";

type FromClientEmitterMap = {
	"message": [StreamReadMessage_FromClient]
	"error": [unknown]
	"end": []
}

type FromServerEmitterMap = {
	"message": [StreamReadMessage_FromServer]
	"error": [unknown]
	"end": []
}

export type TopicReaderSource = {
	/**
	 * Topic path.
	 */
	path: string;
	/**
	 * Partitions that will be read by this session.
	 * If list is empty - then session will read all partitions.
	 */
	partitionIds?: bigint[];
	/**
	 * Skip all messages that has write timestamp smaller than now - max_lag.
	 * Zero means infinite lag.
	 */
	maxLag?: number | StringValue | Duration;
	/**
	 * Read data only after this timestamp from this topic.
	 * Read only messages with 'written_at' value greater or equal than this timestamp.
	 */
	readFrom?: number | Date | Timestamp;
}

export type TopicPartitionCommitOffsets = {
	partitionSession: TopicPartitionSession,
	offsets: {
		start: bigint
		end: bigint
	}[]
}

export type onPartitionSessionStartCallback = (
	partitionSession: TopicPartitionSession,
	committedOffset: bigint,
	partitionOffsets: {
		start: bigint,
		end: bigint
	}
) => Promise<void | undefined | { readOffset?: bigint, commitOffset?: bigint }>

export type onPartitionSessionStopCallback = (
	partitionSession: TopicPartitionSession,
	committedOffset: bigint,
) => Promise<void>

export type onPartitionSessionEndCallback = (partition: {
	partitionSession: TopicPartitionSession,
}) => void

export type onCommittedOffsetCallback = (
	partitionSession: TopicPartitionSession,
	committedOffset: bigint,
) => void

type TopicCommitPromise = {
	partitionSessionId: bigint
	offset: bigint
	resolve: () => void
	reject: (reason?: any) => void
}

export type TopicReaderOptions<Payload = Uint8Array> = {
	// Topic path or an array of topic sources.
	topic: string | TopicReaderSource | TopicReaderSource[]
	// Consumer name.
	consumer: string
	// Maximum size of the internal buffer in bytes.
	// If not provided, the default is 1MB.
	maxBufferBytes?: bigint
	// How often to update the token in milliseconds.
	updateTokenIntervalMs?: number
	// Compression options for the payload.
	compression?: {
		// Custom decompression function that can be used to decompress the payload before emitting it.
		decompress?(codec: Codec, payload: Uint8Array): Uint8Array | Promise<Uint8Array>
	}
	// Custom decode function to decode the payload.
	// If not provided, the payload will be returned as is.
	// Decode function calls after decompression, if compression is used.
	decode?(payload: Uint8Array): Payload
	// Hooks for partition session events.
	// Called when a partition session is started.
	// It can be used to initialize the partition session, for example, to set the read offset.
	onPartitionSessionStart?: onPartitionSessionStartCallback
	// Called when a partition session is stopped.
	// It can be used to commit the offsets for the partition session.
	onPartitionSessionStop?: onPartitionSessionStopCallback
	// Called when receive commit offset response from server.
	// This callback is called after the offsets are committed to the server.
	onCommittedOffset?: onCommittedOffsetCallback
}

export class TopicReader<Payload = Uint8Array> implements Disposable {
	#driver: Driver;
	#options: TopicReaderOptions<Payload>;
	#disposed = false;

	#controller: AbortController = new AbortController();
	#updateTokenTicker: NodeJS.Timeout

	#buffer: StreamReadMessage_ReadResponse[] = [];
	#maxBufferSize: bigint = 1024n * 1024n; // Default buffer size is 1MB
	#freeBufferSize: bigint = 1024n * 1024n; // Default buffer size is 1MB

	#fromClientEmitter = new EventEmitter<FromClientEmitterMap>();
	#fromServerEmitter = new EventEmitter<FromServerEmitterMap>();

	// partition sessions that are currently active.
	#partitionSessions: Map<bigint, TopicPartitionSession> = new Map(); // partitionSessionId -> TopicPartitionSession

	// pending commits that are not yet resolved.
	#pendingCommits: Map<bigint, TopicCommitPromise[]> = new Map(); // partitionSessionId -> TopicCommitPromise[]

	/**
	 * Creates a new TopicReader instance.
	 * @param driver - The YDB driver instance to use for communication with the YDB server.
	 * @param options - Options for the topic reader, including topic path, consumer name, and optional callbacks.
	 */
	constructor(driver: Driver, options: TopicReaderOptions<Payload>) {
		this.#driver = driver;
		this.#options = { ...options };

		if (options.maxBufferBytes) {
			if (typeof options.maxBufferBytes === 'number') {
				this.#maxBufferSize = BigInt(options.maxBufferBytes);
			} else if (typeof options.maxBufferBytes === 'bigint') {
				this.#maxBufferSize = options.maxBufferBytes;
			} else {
				throw new TypeError('maxBufferBytes must be a number or bigint');
			}

			this.#maxBufferSize = this.#maxBufferSize || 1024n * 1024n; // Default max buffer size is 1MB
			this.#freeBufferSize = this.#maxBufferSize; // Initialize buffer size to max buffer size
		}

		if (!options.decode) {
			// Default decode function that returns the payload as is.
			this.#options.decode = (payload: Uint8Array) => payload as Payload;
		}

		// Start consuming the stream immediately.
		void this.#consumeStream()

		/**
		 * Periodically updates the token by emitting an updateTokenRequest message.
		 */
		this.#updateTokenTicker = setInterval(async () => {
			this.#fromClientEmitter.emit('message', create(StreamReadMessage_FromClientSchema, {
				clientMessage: {
					case: 'updateTokenRequest',
					value: {
						token: await this.#driver.token
					},
				}
			}))
		}, this.#options.updateTokenIntervalMs || 60 * 1000)

		// Unref the ticker to allow the process to exit if this is the only active timer.
		this.#updateTokenTicker.unref()

		// Log all messages from client.
		// This is useful for debugging purposes to see what messages are sent to the server.

		let dbgrpc = dbg.extend('grpc')
		this.#fromClientEmitter.on('message', (msg) => {
			dbgrpc('%s %o', msg.$typeName, toJson(StreamReadMessage_FromClientSchema, msg))
		})

		// Log all messages from server.
		this.#fromServerEmitter.on('message', (msg) => {
			dbgrpc('%s %o', msg.$typeName, toJson(StreamReadMessage_FromServerSchema, msg))
		})

		// Handle messages from server.
		this.#fromServerEmitter.on('message', async (message) => {
			if (this.#disposed) {
				dbg('error: receive "%s" after dispose', message.serverMessage.value?.$typeName)
				return
			}

			if (message.serverMessage.case === 'initResponse') {
				dbg(`read session identifier: %s`, message.serverMessage.value.sessionId);

				this.#readMore(this.#freeBufferSize)
			}

			if (message.serverMessage.case === 'startPartitionSessionRequest') {
				assert.ok(message.serverMessage.value.partitionSession, 'startPartitionSessionRequest must have partitionSession');
				assert.ok(message.serverMessage.value.partitionOffsets, 'startPartitionSessionRequest must have partitionOffsets');

				dbg('receive partition with id %s', message.serverMessage.value.partitionSession!.partitionId);

				let partitionSession: TopicPartitionSession = new TopicPartitionSession(
					message.serverMessage.value.partitionSession.partitionSessionId,
					message.serverMessage.value.partitionSession.partitionId,
					message.serverMessage.value.partitionSession.path
				);

				// save partition session.
				this.#partitionSessions.set(partitionSession.partitionSessionId, partitionSession);

				// Initialize offsets.
				let readOffset = message.serverMessage.value.partitionOffsets.start;
				let commitOffset = message.serverMessage.value.committedOffset;

				// Call onPartitionSessionStart callback if it is defined.
				if (this.#options.onPartitionSessionStart) {
					let committedOffset = message.serverMessage.value.committedOffset;
					let partitionOffsets = message.serverMessage.value.partitionOffsets;

					let response = await this.#options.onPartitionSessionStart(partitionSession, committedOffset, partitionOffsets).catch((err) => {
						dbg('error: onPartitionSessionStart error: %O', err);
						this.#fromClientEmitter.emit('error', err);

						return undefined;
					});

					if (response) {
						readOffset = response.readOffset || 0n;
						commitOffset = response.commitOffset || 0n;
					}
				}

				let pendingCommits = this.#pendingCommits.get(partitionSession.partitionSessionId);
				if (pendingCommits?.length) {
					// If there are pending commits for this partition session, resolve them.
					let i = 0;
					while (i < pendingCommits.length) {
						let commit = pendingCommits[i];
						if (commit.offset <= commitOffset) {
							// If the commit offset is less than or equal to the committed offset, resolve it.
							commit.resolve();
							pendingCommits.splice(i, 1); // Remove from pending commits
						} else {
							i++;
						}
					}
				}

				// If there are no pending commits for this partition session, remove it from the map.
				if (pendingCommits && pendingCommits.length === 0) {
					this.#pendingCommits.delete(partitionSession.partitionSessionId);
				}

				this.#fromClientEmitter.emit('message', create(StreamReadMessage_FromClientSchema, {
					clientMessage: {
						case: 'startPartitionSessionResponse',
						value: {
							partitionSessionId: partitionSession.partitionSessionId,
							readOffset,
							commitOffset
						}
					}
				}))
			}

			if (message.serverMessage.case === 'stopPartitionSessionRequest') {
				assert.ok(message.serverMessage.value.partitionSessionId, 'stopPartitionSessionRequest must have partitionSessionId');

				let partitionSession = this.#partitionSessions.get(message.serverMessage.value.partitionSessionId);
				if (!partitionSession) {
					dbg('error: stopPartitionSessionRequest for unknown partitionSessionId=%s', message.serverMessage.value.partitionSessionId);
					return;
				}

				if (this.#options.onPartitionSessionStop) {
					let committedOffset = message.serverMessage.value.committedOffset || 0n;

					await this.#options.onPartitionSessionStop(partitionSession, committedOffset).catch((err) => {
						dbg('error: onPartitionSessionStop error: %O', err);
						this.#fromClientEmitter.emit('error', err);
					});
				}

				// If graceful stop is not requested, we can stop the partition session immediately.
				if (!message.serverMessage.value.graceful) {
					dbg('stop partition session %s without graceful stop', partitionSession.partitionSessionId);
					partitionSession.stop();
					this.#partitionSessions.delete(partitionSession.partitionSessionId);

					// Remove all messages from the buffer that belong to this partition session.
					for (let part of this.#buffer) {
						// Remove all messages from the buffer that belong to this partition session.
						let i = 0;
						while (i < part.partitionData.length) {
							if (part.partitionData[i].partitionSessionId === partitionSession.partitionSessionId) {
								part.partitionData.splice(i, 1);
							} else {
								i++;
							}
						}
					}

					let pendingCommits = this.#pendingCommits.get(partitionSession.partitionSessionId);
					if (pendingCommits) {
						// If there are pending commits for this partition session, reject them.
						for (let commit of pendingCommits) {
							commit.reject('Partition session stopped without graceful stop');
						}

						this.#pendingCommits.delete(partitionSession.partitionSessionId);
					}

					return;
				}

				// Отсылать ответ после того, как прочитали все сообщения из внутреннего буфера по конкретной partition session.
				// Чтение из внутреннего будфера происходит в функции read().

				this.#fromClientEmitter.emit('message', create(StreamReadMessage_FromClientSchema, {
					clientMessage: {
						case: 'stopPartitionSessionResponse',
						value: {
							partitionSessionId: partitionSession.partitionSessionId
						}
					}
				}))
			}

			if (message.serverMessage.case === 'endPartitionSession') {
				assert.ok(message.serverMessage.value.partitionSessionId, 'endPartitionSession must have partitionSessionId');

				let partitionSession = this.#partitionSessions.get(message.serverMessage.value.partitionSessionId);
				if (!partitionSession) {
					dbg('error: endPartitionSession for unknown partitionSessionId=%s', message.serverMessage.value.partitionSessionId);
					return;
				}

				partitionSession.end();
			}

			if (message.serverMessage.case === 'commitOffsetResponse') {
				assert.ok(message.serverMessage.value.partitionsCommittedOffsets, 'commitOffsetResponse must have partitionsCommittedOffsets');

				if (this.#options.onCommittedOffset) {
					for (let part of message.serverMessage.value.partitionsCommittedOffsets) {
						let partitionSession = this.#partitionSessions.get(part.partitionSessionId);
						if (!partitionSession) {
							dbg('error: commitOffsetResponse for unknown partitionSessionId=%s', part.partitionSessionId);
							continue;
						}

						this.#options.onCommittedOffset(partitionSession, part.committedOffset)
					}
				}

				// Resolve all pending commits for the partition sessions.
				for (let part of message.serverMessage.value.partitionsCommittedOffsets) {
					let partitionSessionId = part.partitionSessionId;
					let committedOffset = part.committedOffset;

					// Resolve all pending commits for this partition session.
					let pendingCommits = this.#pendingCommits.get(partitionSessionId);
					if (pendingCommits) {
						let i = 0;
						while (i < pendingCommits.length) {
							let commit = pendingCommits[i];
							if (commit.offset <= committedOffset) {
								// If the commit offset is less than or equal to the committed offset, resolve it.
								commit.resolve();
								pendingCommits.splice(i, 1); // Remove from pending commits
							} else {
								i++;
							}
						}
					}

					// If there are no pending commits for this partition session, remove it from the map.
					if (pendingCommits && pendingCommits.length === 0) {
						this.#pendingCommits.delete(partitionSessionId);
					}
				}
			}
		});

		process.once('SIGINT', () => {
			dbg('SIGINT received, disposing reader');
			this.dispose()
		})
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

		// Configure retry strategy for stream consumption
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
				using outgoing = new AsyncEventEmitter<StreamReadMessage_FromClient>(this.#fromClientEmitter, 'message')

				dbg('connecting to the stream with consumer %s', this.#options.consumer);

				let stream = this.#driver
					.createClient(TopicServiceDefinition)
					.streamRead(outgoing, { signal });

				// If we have pending commits, we need to reject and drop them before connecting to the stream.
				if (this.#pendingCommits.size) {
					dbg('has pending commits, before connecting to the stream, rejecting them');

					for (let [partitionSessionId, pendingCommits] of this.#pendingCommits) {
						for (let commit of pendingCommits) {
							commit.reject(new Error(`Pending commit for partition session ${partitionSessionId} rejected before connecting to the stream`));
						}
					}

					this.#pendingCommits.clear();
				}

				// If we have buffered messages, we need to clear them before connecting to the stream.
				if (this.#buffer.length) {
					dbg('has %d messages in the buffer before connecting to the stream, clearing it', this.#buffer.length);
					this.#buffer.length = 0; // Clear the buffer before connecting to the stream
					this.#freeBufferSize = this.#maxBufferSize; // Reset free buffer size
				}

				nextTick(() => {
					this.#fromClientEmitter.emit('message', create(StreamReadMessage_FromClientSchema, {
						clientMessage: {
							case: 'initRequest',
							value: {
								consumer: this.#options.consumer,
								topicsReadSettings: this.#topicsReadSettings,
								autoPartitioningSupport: false
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
	 * Gets the read settings for topics configured in the reader options.
	 * @returns An array of StreamReadMessage_InitRequest_TopicReadSettings objects representing the read settings for each topic.
	 *
	 * This method processes the topic options and converts them into an array of
	 * StreamReadMessage_InitRequest_TopicReadSettings objects, handling different types
	 * for maxLag and readFrom fields appropriately.
	 *
	 * @returns An array of StreamReadMessage_InitRequest_TopicReadSettings objects representing the read settings for each topic.
	 */
	get #topicsReadSettings(): StreamReadMessage_InitRequest_TopicReadSettings[] {
		let settings: StreamReadMessage_InitRequest_TopicReadSettings[] = []

		function parseDuration(duration: number | StringValue | Duration | undefined): Duration | undefined {
			if (duration === undefined) {
				return undefined;
			}

			if (typeof duration === 'string') {
				duration = ms(duration);
			}

			if (typeof duration === 'number') {
				let seconds = Math.floor(duration / 1000);

				return create(DurationSchema, {
					seconds: protoInt64.parse(seconds),
					nanos: (duration - seconds * 1000) * 1000000,
				})
			}

			return duration;
		}

		function parseTimestamp(timestamp: number | Date | Timestamp | undefined): Timestamp | undefined {
			if (timestamp === undefined) {
				return undefined;
			}

			if (typeof timestamp === 'number') {
				timestamp = new Date(timestamp);
			}

			if (timestamp instanceof Date) {
				timestamp = timestampFromDate(timestamp);
			}

			return timestamp;
		}

		if (typeof this.#options.topic === "string") {
			settings.push(
				create(StreamReadMessage_InitRequest_TopicReadSettingsSchema, {
					path: this.#options.topic
				})
			)
		} else if (!Array.isArray(this.#options.topic)) {
			this.#options.topic = [this.#options.topic]
		}

		if (Array.isArray(this.#options.topic)) {
			for (let topic of this.#options.topic) {
				settings.push(
					create(StreamReadMessage_InitRequest_TopicReadSettingsSchema, {
						path: topic.path,
						partitionIds: topic.partitionIds,
						maxLag: parseDuration(topic.maxLag),
						readFrom: parseTimestamp(topic.readFrom)
					})
				)
			}
		}

		return settings;
	}

	/**
	 * Requests more data from the stream.
	 * This method emits a readRequest message to the server with the specified bytes size.
	 * The default size is 1MB, but it can be overridden by the maxBufferBytes option.
	 */
	#readMore(bytes: bigint): void {
		if (this.#disposed) {
			dbg('error: readMore called after dispose');
			return;
		}

		dbg('request read next %d bytes', bytes);
		this.#fromClientEmitter.emit("message", create(StreamReadMessage_FromClientSchema, {
			clientMessage: {
				case: 'readRequest',
				value: {
					bytesSize: bytes
				}
			}
		}))
	}

	/**
	 * Reads messages from the topic stream.
	 * This method returns an async iterable that yields TopicMessage[] objects.
	 * It handles reading messages in batches, managing partition sessions, and buffering messages.
	 * The method supports options for limiting the number of messages read, setting a timeout,
	 * and using an AbortSignal to cancel the read operation.
	 *
	 * If limit is provided, it will read up to the specified number of messages.
	 * If no limit is provided, it will read messages as fast as they are available,
	 * up to the maximum buffer size defined in the options.
	 *
	 * If timeout is provided, it will wait for messages until the specified time elapses.
	 * After the timeout, it emits an empty TopicMessage[] if no messages were read.
	 *
	 * The signal option allows for cancellation of the read operation.
	 * If provided, it will merge with the reader's controller signal to allow for cancellation.
	 *
	 * @param {Object} options - Options for reading messages.
	 * @param {number} [options.limit=Infinity] - The maximum number of messages to read. Default is Infinity.
	 * @param {number} [options.waitMs=60_000] - The maximum time to wait for messages before timing out. If not provided, it will wait 1 minute.
	 * @param {AbortSignal} [options.signal] - An AbortSignal to cancel the read operation. If provided, it will merge with the reader's controller signal.
	 * @returns {AsyncIterable<TopicMessage[]>} An async iterable that yields TopicMessage[] objects.
	 */
	read(options: { limit?: number, waitMs?: number, signal?: AbortSignal } = {}): AsyncIterable<TopicMessage<Payload>[]> {
		let limit = options.limit || Infinity,
			signal = options.signal,
			waitMs = options.waitMs || 60_000;

		// Check if the reader has been disposed, cannot read with disposed reader
		if (this.#disposed) {
			throw new Error('Reader is disposed');
		}

		// Merge the provided signal with the reader's controller signal.
		if (signal) {
			signal = AbortSignal.any([this.#controller.signal, signal]);
		} else {
			signal = this.#controller.signal;
		}

		// If the signal is already aborted, throw an error immediately.
		if (signal.aborted) {
			throw new Error('Read aborted', { cause: signal.reason });
		}

		let active = true;
		let messageHandler = (message: StreamReadMessage_FromServer) => {
			if (signal.aborted) {
				return;
			}

			if (message.serverMessage.case != 'readResponse') {
				return;
			}

			dbg('reader received %d bytes', message.serverMessage.value.bytesSize);

			this.#buffer.push(message.serverMessage.value);
			this.#freeBufferSize -= message.serverMessage.value.bytesSize;
		}

		// On error or end, deactivate the iterator and clean up listeners.
		let errorHandler = () => {
			if (signal.aborted) {
				return; // Ignore errors if the signal is already aborted
			}

			active = false;
			cleanup();
		}

		let endHandler = () => {
			if (signal.aborted) {
				return; // Ignore end if the signal is already aborted
			}

			active = false;
			cleanup();
		}

		let abortHandler = async () => {
			active = false;
			cleanup();
		}

		// Cleanup function to remove all listeners after resolution or rejection.
		let cleanup = () => {
			this.#fromServerEmitter.removeListener('message', messageHandler);
			this.#fromServerEmitter.removeListener('error', errorHandler);
			this.#fromServerEmitter.removeListener('end', endHandler);
			if (signal) {
				signal.removeEventListener('abort', abortHandler);
			}
		};

		return {
			[Symbol.asyncIterator]: () => {
				this.#fromServerEmitter.on('message', messageHandler);
				this.#fromServerEmitter.on('error', errorHandler);
				this.#fromServerEmitter.on('end', endHandler);
				signal?.addEventListener('abort', abortHandler);

				return {
					next: async () => {
						// If the reader is disposed, throw an error.
						if (this.#disposed) {
							throw new Error('Reader is disposed');
						}

						// If the signal is already aborted, throw an error immediately.
						if (signal.aborted) {
							throw new Error('Read aborted', { cause: signal.reason });
						}

						// If the reader is not active, return done
						if (!active) {
							return { value: [], done: true };
						}

						let messages: TopicMessage<Payload>[] = [];

						// Wait for the next readResponse or until the timeout expires.
						if (!this.#buffer.length) {
							let waiter = Promise.withResolvers()
							this.#fromServerEmitter.once('message', waiter.resolve)

							await Promise.race([
								waiter.promise,
								once(signal, 'abort'),
								once(AbortSignal.timeout(waitMs), 'abort'),
							])

							this.#fromServerEmitter.removeListener('message', waiter.resolve)

							// If the signal is already aborted, throw an error immediately.
							if (signal.aborted) {
								throw new Error('Read aborted', { cause: signal.reason });
							}

							// If the reader is disposed, throw an error.
							if (this.#disposed) {
								throw new Error('Reader is disposed');
							}

							// NB: DO NOT break the loop here, we need to process the buffer even if it is empty.
						}

						let releasableBufferBytes = 0n;

						while (this.#buffer.length) {
							let fullRead = true;
							let response = this.#buffer.shift()!; // Get the first response from the buffer
							if (response.partitionData.length === 0) {
								continue; // Skip empty responses
							}

							// If we have a limit and reached it, break the loop
							if (messages.length >= limit) {
								this.#buffer.unshift(response); // Put the response back to the front of the buffer
								break;
							}

							while (response.partitionData.length) {
								let pd = response.partitionData.shift()!; // Get the first partition data
								if (pd.batches.length === 0) {
									continue; // Skip empty partition data
								}

								// If we have a limit and reached it, break the loop
								if (messages.length >= limit) {
									response.partitionData.unshift(pd); // Put the partition data back to the front of the response
									break;
								}

								while (pd.batches.length) {
									let batch = pd.batches.shift()!; // Get the first batch
									if (batch.messageData.length === 0) {
										continue; // Skip empty batches
									}

									// If we have a limit and reached it, break the loop
									if (messages.length >= limit) {
										pd.batches.unshift(batch); // Put the batch back to the front of the partition data

										break;
									}

									let partitionSession = this.#partitionSessions.get(pd.partitionSessionId);
									if (!partitionSession) {
										dbg('error: readResponse for unknown partitionSessionId=%s', pd.partitionSessionId);
										continue;
									}

									while (batch.messageData.length) {
										// Process each message in the batch
										let msg = batch.messageData.shift()!; // Get the first message from the batch

										// If we have a limit and reached it, break the loop
										if (messages.length >= limit) {
											batch.messageData.unshift(msg); // Put the message back to the front of the batch
											break;
										}

										let data = msg.data;
										if (batch.codec !== Codec.UNSPECIFIED) {
											if (!this.#options.compression || !this.#options.compression.decompress) {
												dbg('error: cannot decompress message with codec %s, no decompression function provided', batch.codec);

												throw new Error(`Cannot decompress message with codec ${batch.codec}, no decompression function provided`);
											}

											// Decompress the message data using the provided decompress function
											try {
												// eslint-disable-next-line no-await-in-loop
												data = await this.#options.compression.decompress(batch.codec, msg.data);
											} catch (err) {
												dbg('error: decompression failed for message with codec %s: %O', batch.codec, err);

												throw new Error(`Decompression failed for message with codec ${batch.codec}`, { cause: err });
											}
										}

										// Process the message
										let message: TopicMessage<Payload> = {
											codec: batch.codec,
											partitionSessionId: partitionSession.partitionSessionId,
											partitionId: partitionSession.partitionId,
											producerId: batch.producerId,
											seqNo: msg.seqNo,
											offset: msg.offset,
											payload: this.#options.decode?.(data) || data as Payload,
											uncompressedSize: msg.uncompressedSize,
											createdAt: msg.createdAt ? timestampDate(msg.createdAt) : undefined,
											writtenAt: batch.writtenAt ? timestampDate(batch.writtenAt) : undefined,
											metadataItems: msg.metadataItems ? Object.fromEntries(msg.metadataItems.map(item => [item.key, item.value])) : undefined,
										}

										messages.push(message);
									}

									if (batch.messageData.length != 0) {
										fullRead = false;
										pd.batches.unshift(batch); // Put the batch back to the front of the partition data
									}
								}

								if (pd.batches.length != 0) {
									fullRead = false;
									response.partitionData.unshift(pd); // Put the partition data back to the front of the response
								}
							}

							if (response.partitionData.length != 0) {
								fullRead = false;
								this.#buffer.unshift(response); // Put the response back to the front of the buffer
							}

							// If we have read all messages from the response, we can release its buffer allocation
							if (response.partitionData.length === 0 && fullRead) {
								releasableBufferBytes += response.bytesSize;
							}
						}

						dbg('return %d messages, buffer size is %d bytes, free buffer size is %d bytes', messages.length, this.#maxBufferSize - this.#freeBufferSize, this.#freeBufferSize);

						if (releasableBufferBytes > 0n) {
							dbg('releasing %d bytes from buffer', releasableBufferBytes);
							this.#freeBufferSize += releasableBufferBytes;
							this.#readMore(releasableBufferBytes);
						}

						return { value: messages, done: !active };
					},
					return: async (value) => {
						// Cleanup: remove the message handler when the iterator is closed.
						cleanup();

						return { value, done: true };
					},
				}
			}
		}
	}

	/**
	 * Commits offsets for the provided messages.
	 *
	 * Sends a commit offset request to the server, grouping offsets by partition session and merging consecutive offsets into ranges.
	 * Accepts a single TopicMessage, an array of TopicMessages, or a TopicMessage[].
	 *
	 * Returns a thenable (lazy promise) that resolves when the server acknowledges the commit.
	 *
	 * Note: Do not `await` this method directly in hot paths, as commit resolution may be delayed or never occur if the stream closes.
	 *
	 * Throws if the reader is disposed or if any message lacks a partitionSessionId.
	 *
	 * @param input - TopicMessage or TopicMessage[] to commit.
	 * @returns Promise<void> that resolves when the commit is acknowledged.
	 */
	commit(input: TopicMessage | TopicMessage[]): Promise<void> {
		// Check if the reader has been disposed, cannot commit with disposed reader
		if (this.#disposed) {
			throw new Error('Reader is disposed');
		}

		// Normalize input to an array of messages regardless of input type
		// This handles single message or array of messages
		if (!Array.isArray(input)) {
			input = [input]; // Convert single message to array
		}

		// If input is empty, resolve immediately.
		if (input.length === 0) {
			return Promise.resolve();
		}

		// Arrays to hold the final commit request structure
		let commitOffsets: StreamReadMessage_CommitOffsetRequest_PartitionCommitOffset[] = [];
		// Map to group and organize offsets by partition session ID
		let offsets: Map<bigint, OffsetsRange[]> = new Map();

		// Process each message to be committed
		for (let msg of input) {
			// Each message must have a valid partition session ID
			if (!msg.partitionSessionId) {
				throw new Error(`Message with offset ${msg.offset} does not have partitionSessionId.`);
			}

			// Verify the partition session exists in our tracked sessions
			let partitionSession = this.#partitionSessions.get(msg.partitionSessionId);
			if (!partitionSession) {
				throw new Error(`Partition session with id ${msg.partitionSessionId} not found.`);
			}

			// Initialize empty array for this partition if it doesn't exist yet
			if (!offsets.has(partitionSession.partitionSessionId)) {
				offsets.set(partitionSession.partitionSessionId, []);
			}

			let partOffsets = offsets.get(partitionSession.partitionSessionId)!;
			let offset = msg.offset!;

			// Optimize storage by merging consecutive offsets into ranges
			// This reduces network traffic and improves performance
			if (partOffsets.length > 0) {
				let last = partOffsets[partOffsets.length - 1];

				if (offset === last.end) {
					// If the new offset is consecutive to the last range, extend the range
					// This creates a continuous range (e.g. 1-5 instead of 1-4, 5)
					last.end = offset + 1n;
				} else if (offset > last.end) {
					// If there's a gap between offsets, create a new range
					// This handles non-consecutive offsets properly
					partOffsets.push(create(OffsetsRangeSchema, { start: offset, end: offset + 1n }));
				} else {
					// If offset <= last.end, it's either out of order or a duplicate.
					throw new Error(`Message with offset ${offset} is out of order or duplicate for partition session ${partitionSession.partitionSessionId}`);
				}
			} else {
				// First offset for this partition, create initial range
				partOffsets.push(create(OffsetsRangeSchema, { start: offset, end: offset + 1n }));
			}
		}

		// Convert our optimized Map structure into the API's expected format
		for (let [partitionSessionId, partOffsets] of offsets.entries()) {
			dbg('committing offsets for partition session %s: %o', partitionSessionId, partOffsets);

			commitOffsets.push(create(StreamReadMessage_CommitOffsetRequest_PartitionCommitOffsetSchema, {
				partitionSessionId,
				offsets: partOffsets
			}));
		}

		// Send the commit request to the server
		this.#fromClientEmitter.emit("message", create(StreamReadMessage_FromClientSchema, {
			clientMessage: {
				case: 'commitOffsetRequest',
				value: {
					commitOffsets
				}
			}
		}));

		// Create a promise that resolves when the commit is acknowledged by the server.
		return new Promise((resolve, reject) => {
			for (let [partitionSessionId, partOffsets] of offsets.entries()) {
				// Create a commit promise for each partition session
				let commitPromise: TopicCommitPromise = {
					partitionSessionId,
					offset: partOffsets[partOffsets.length - 1].end, // Use the last offset in the range
					resolve,
					reject
				};

				// Add to pending commits map
				if (!this.#pendingCommits.has(partitionSessionId)) {
					this.#pendingCommits.set(partitionSessionId, []);
				}

				// Push the commit promise to the pending commits for this partition session
				this.#pendingCommits.get(partitionSessionId)!.push(commitPromise);
			}
		});
	}

	/**
	 * Disposes the TopicReader instance, cleaning up resources and aborting the stream.
	 * This method should be called when the reader is no longer needed to prevent memory leaks.
	 */
	dispose() {
		if (this.#disposed) {
			return; // Already disposed, nothing to do
		}
		this.#disposed = true;
		dbg('disposing TopicReader for consumer %s', this.#options.consumer);

		this.#buffer.length = 0 // Clear the buffer to release memory
		this.#freeBufferSize = this.#maxBufferSize; // Reset free buffer size to max buffer size

		for (let partitionSession of this.#partitionSessions.values()) {
			// Stop all partition sessions gracefully
			partitionSession.stop();
		}

		this.#partitionSessions.clear() // Clear partition sessions to release memory

		for (let [partitionSessionId, pendingCommits] of this.#pendingCommits.entries()) {
			// Reject all pending commits for this partition session
			for (let commit of pendingCommits) {
				commit.reject(new Error(`Reader disposed, commit for partition session ${partitionSessionId} rejected`));
			}

			this.#pendingCommits.delete(partitionSessionId); // Remove from pending commits
		}

		this.#pendingCommits.clear() // Clear pending commits to release memory

		this.#fromClientEmitter.removeAllListeners()
		this.#fromServerEmitter.removeAllListeners()

		clearInterval(this.#updateTokenTicker)
		this.#controller.abort()
	}

	[Symbol.dispose]() {
		this.dispose()
	}
}
