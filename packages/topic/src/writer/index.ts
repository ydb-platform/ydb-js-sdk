import { nextTick } from "node:process";

import { StatusIds_StatusCode } from "@ydbjs/api/operation";
import { Codec, type StreamWriteMessage_FromClient, type StreamWriteMessage_WriteRequest_MessageData, TopicServiceDefinition } from "@ydbjs/api/topic";
import type { Driver } from "@ydbjs/core";
import { YDBError } from "@ydbjs/error";
import { type RetryConfig, retry } from "@ydbjs/retry";
import { backoff, combine, jitter } from "@ydbjs/retry/strategy";
import debug from "debug";

import { PQueue } from "../queue.js";
import { _flush } from "./_flush.js";
import { _get_producer_id } from "./_gen_producer_id.js";
import { _on_init_response } from "./_init_reponse.js";
import { _send_init_request } from "./_init_request.js";
import { _send_update_token_request } from "./_update_token.js";
import { _write } from "./_write.js";
import { _on_write_response } from "./_write_response.js";
import { MAX_BUFFER_SIZE } from "./constants.js";

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
		compress(payload: Uint8Array): Uint8Array
	}
	// Whether to handle SIGINT signal and close the writer gracefully.
	// If true, the writer will listen for SIGINT signal and close the writer gracefully.
	handleSIGINT?: boolean
	// Retry configuration for the writer.
	retryConfig?(signal: AbortSignal): RetryConfig
	// Custom encoding function that can be used to transform the payload before compressing or sending it to the topic.
	encode?(payload: Payload): Uint8Array
	// Callback that is called when writer receives an acknowledgment for a message.
	onAck?: (seqNo: bigint, status?: 'skipped' | 'written' | 'writtenInTx') => void
}

export interface TopicWriter<Payload = Uint8Array> extends Disposable, AsyncDisposable {
	// Write a message to the topic.
	// Returns a promise that resolves to the sequence number of the message that was written to the topic.
	write(payload: Payload | Uint8Array, extra?: { seqNo?: bigint, createdAt?: Date, metadataItems?: Record<string, Uint8Array> }): Promise<bigint>;
	// Flush the buffer and send all messages to the topic.
	// Returns a promise that resolves to the last sequence number of the topic after flushing.
	flush(): Promise<bigint | undefined>;
	// Close the writer and release all resources.
	// If a reason is provided, it will be used to reject all pending acknowledgments.
	close(reason?: Error): void;
}

export function createTopicWriter<Payload = Uint8Array>(driver: Driver, options: TopicWriterOptions<Payload>): TopicWriter<Payload> {
	// Generate a random producer name if not provided.
	options.producer ??= _get_producer_id();
	// Automatically get the last sequence number of the topic before starting to write messages.
	options.getLastSeqNo ??= true;
	// Allow duplicates in the topic, default is false.
	if (options.allowDuplicates) {
		options.producer = undefined; // If duplicates are allowed, producerId is not used.
		options.getLastSeqNo = false; // If duplicates are allowed, we don't need to get the last sequence number.
	}
	// Default intervals
	options.flushIntervalMs ??= 60_000; // Default is 60 seconds.
	options.updateTokenIntervalMs ??= 60_000; // Default is 60 seconds.

	let dbg = debug('ydbjs').extend('topic').extend('writer')

	// Last sequence number of the topic.
	// Automatically get the last sequence number of the topic before starting to write messages.
	let lastSeqNo: bigint | undefined;
	// Flag to indicate if the sequence number is provided by the user.
	// If the user provides a sequence number, it will be used instead of the computed sequence number.
	// If the user provides a sequence number, all subsequent messages must have a sequence number provided.
	let isSeqNoProvided: boolean = false;

	// Map of sequence numbers to messages that are currently in the buffer.
	// This is used to keep track of messages that are not yet sent to the server.
	let buffer: Map<bigint, StreamWriteMessage_WriteRequest_MessageData> = new Map(); // seqNo -> message
	let bufferSize: bigint = 0n;

	// In-flight messages that are not yet acknowledged.
	// This is used to keep track of messages that are currently being sent to the server.
	let inflight: Set<bigint> = new Set(); // seqNo

	// Map of pending acknowledgments.
	// This is used to keep track of messages that are waiting for acknowledgment from the server.
	// The key is the sequence number of the message, and the value is a promise that will be resolved when the acknowledgment is received.
	let pendingAcks: Map<bigint, PromiseWithResolvers<bigint>> = new Map(); // seqNo -> PromiseWithResolvers

	// Abort controller for cancelling requests.
	let ac = new AbortController();
	let signal = ac.signal;

	// Flag to indicate if the writer is ready to send messages.
	// When the writer stream is not ready, it will queue messages to be sent later.
	let isReady = false;
	// Flag to indicate if the writer is closed.
	// When the writer is closed, it will not accept new messages and will reject all pending write requests.
	// This is useful to ensure that the writer does not leak resources and can be closed gracefully.
	let isClosed = false;
	// Queue for messages to be written.
	// This is used to store messages that are not yet sent to the topic service.
	let queue: {
		payload: Payload; extra: any;
		resolve: (value: bigint) => void;
		reject: (error: unknown) => void;
	}[] = [];

	// This function is used to update the last sequence number of the topic.
	function updateLastSeqNo(seqNo: bigint) {
		lastSeqNo = seqNo;
	}

	// This function is used to update the buffer size when a message is added to the buffer.
	function updateBufferSize(bytes: bigint) {
		bufferSize += bytes;
	}

	// This function is used to process the write queue when the writer is ready.
	// It will take all messages from the queue and write them to the buffer.
	function processQueue() {
		if (!isReady) return;

		// Copy the write queue to process it.
		// This is necessary to avoid modifying the queue while processing it.
		const qq = [...queue];
		queue = [];

		dbg('processing write queue, size: %d', qq.length);

		for (const item of qq) {
			_write({
				queue: outgoing,
				codec: options.compression?.codec || Codec.RAW,
				lastSeqNo: (lastSeqNo || item.extra.seqNo)!,
				buffer,
				inflight,
				pendingAcks,
				bufferSize,
				maxBufferSize: options.maxBufferBytes || MAX_BUFFER_SIZE,
				encode: options.encode || ((data: Payload) => data as Uint8Array),
				compress: options.compression?.compress || ((data: Uint8Array) => data),
				updateLastSeqNo,
				updateBufferSize,
			}, {
				data: item.payload,
				seqNo: item.extra.seqNo,
				createdAt: item.extra.createdAt,
				metadataItems: item.extra.metadataItems
			})
				.then(item.resolve)
				.catch(item.reject);
		}
	}

	// Create an outgoing stream that will be used to send messages to the topic service.
	let outgoing = new PQueue<StreamWriteMessage_FromClient>();

	// Flush the buffer periodically to ensure that messages are sent to the topic.
	// This is useful to avoid holding too many messages in memory and to ensure that the writer does not leak memory.
	// The flush interval is configurable and defaults to 60 seconds.
	let backgroundFlusher = setInterval(async () => {
		await driver.ready(signal);

		_flush({
			queue: outgoing,
			codec: options.compression?.codec || Codec.RAW,
			buffer,
			inflight,
			updateBufferSize,
		});
	}, options.flushIntervalMs, { signal });

	// Update the token periodically to ensure that the writer has a valid token.
	// This is useful to avoid token expiration and to ensure that the writer can continue to write messages to the topic.
	// The update token interval is configurable and defaults to 60 seconds.
	let backgroundTokenRefresher = setInterval(async () => {
		await driver.ready(signal);

		_send_update_token_request({
			queue: outgoing,
			token: await driver.token,
		})
	}, options.updateTokenIntervalMs, { signal });

	// If the user requested to handle SIGINT signal, listen for it and close the writer gracefully.
	// This is useful to ensure that the writer does not leak resources and to ensure that the writer can be closed gracefully.
	// If the user does not want to handle SIGINT signal, the writer will not listen for it and will not close gracefully.
	if (options.handleSIGINT) {
		process.on('SIGINT', async () => {
			dbg('received SIGINT signal, closing writer');
			await flush();
			close(new Error('SIGINT received'));
		});
	}

	// Start the stream to the topic service.
	// This is the main function that will handle the streaming of messages to the topic service.
	// It will handle the initialization of the stream, sending messages to the topic service,
	// and handling responses from the topic service.
	// It will also handle retries in case of errors or connection failures.
	// The stream will be retried if it fails or receives an error.
	void (async function stream() {
		await driver.ready(signal);

		let retryConfig = options.retryConfig?.(signal) || {
			retry: true,
			signal: signal,
			budget: Infinity,
			strategy: combine(jitter(50), backoff(50, 5000)),
			onRetry(ctx) {
				dbg('retrying stream connection, attempt %d, error: %O', ctx.attempt, ctx.error);
			},
		}

		try {
			// Start the stream to the topic service.
			// Retry the connection if it fails or receives an error.
			await retry(retryConfig, async (signal) => {
				isReady = false;
				inflight.clear();

				let stream = driver.createClient(TopicServiceDefinition).streamWrite(outgoing, { signal });

				// Send the initial request to the server to initialize the stream.
				nextTick(() => {
					dbg('sending init request to server, producer: %s', options.producer);

					_send_init_request({
						queue: outgoing,
						topic: options.topic,
						producer: options.producer,
						getLastSeqNo: options.getLastSeqNo
					});
				})

				for await (const chunk of stream) {
					dbg('receive message from server: %s, status: %d, payload: %o', chunk.$typeName, chunk.status, chunk.serverMessage.value);

					if (chunk.status !== StatusIds_StatusCode.SUCCESS) {
						let error = new YDBError(chunk.status || StatusIds_StatusCode.STATUS_CODE_UNSPECIFIED, chunk.issues || [])
						throw error;
					}

					switch (chunk.serverMessage.case) {
						case 'initResponse':
							_on_init_response({
								queue: outgoing,
								codec: options.compression?.codec || Codec.RAW,
								buffer,
								inflight,
								lastSeqNo,
								updateLastSeqNo,
								updateBufferSize,
							}, chunk.serverMessage.value);

							isReady = true;
							processQueue();

							break
						case 'writeResponse':
							_on_write_response({
								queue: outgoing,
								codec: options.compression?.codec || Codec.RAW,
								buffer,
								inflight,
								pendingAcks,
								onAck: options.onAck,
								updateBufferSize,
							}, chunk.serverMessage.value);
							break
					}
				}
			})
		} catch (err) {
			dbg('error occurred while streaming: %O', err);
		} finally {
			dbg('stream closed');
			outgoing.close()
			ac.abort();
		}
	})()

	// This function is used to flush the buffer and send the messages to the topic.
	// It will send all messages in the buffer to the topic service and wait for them to be acknowledged.
	// If the buffer is empty, it will return immediately.
	// Returns the last sequence number of the topic after flushing.
	async function flush(): Promise<bigint | undefined> {
		if (!buffer.size) {
			return lastSeqNo;
		}

		while (buffer.size > 0) {
			dbg('waiting for inflight messages to be acknowledged, inflight size: %d, buffer size: %d', inflight.size, buffer.size);

			// Wait for all pending acks to be resolved before flushing.
			// eslint-disable-next-line no-await-in-loop
			await Promise.all(Array.from(pendingAcks.values()).map(pendingAck => pendingAck.promise))
		}

		return lastSeqNo;
	}

	// This function is used to write a message to the topic.
	// It will add the message to the buffer and return a promise.
	// If writer is not ready, it will add the message to the write queue and return a promise.
	// Promise will be resolved when the message is acknowledged by the topic service.
	// Returns the sequence number of the message that was written to the topic.
	// If the sequence number is not provided, it will use the last sequence number of the topic.
	function write(payload: Payload, extra: { seqNo?: bigint, createdAt?: Date, metadataItems?: Record<string, Uint8Array> } = {}): Promise<bigint> {
		if (isClosed) {
			throw new Error('Writer is closed, cannot write messages');
		}

		if (!extra.seqNo && isSeqNoProvided) {
			throw new Error('Missing sequence number for message. Sequence number is provided by the user previously, so after that all messages must have seqNo provided');
		}

		// If a sequence number is provided, use it.
		if (extra.seqNo) {
			isSeqNoProvided = true;
		}

		if (!isReady) {
			dbg('adding write request to queue, queue size: %d', queue.length + 1);
			return new Promise<bigint>((resolve, reject) => {
				queue.push({
					payload,
					extra,
					resolve,
					reject
				});
			});
		}

		return _write({
			queue: outgoing,
			codec: options.compression?.codec || Codec.RAW,
			lastSeqNo: (lastSeqNo || extra.seqNo)!,
			buffer,
			inflight,
			pendingAcks,
			bufferSize,
			maxBufferSize: options.maxBufferBytes || MAX_BUFFER_SIZE,
			encode: options.encode || ((data: Payload) => data as Uint8Array),
			compress: options.compression?.compress || ((data: Uint8Array) => data),
			updateLastSeqNo,
			updateBufferSize,
		}, { data: payload, seqNo: extra.seqNo, createdAt: extra.createdAt, metadataItems: extra.metadataItems });
	}

	// This function is used to close the writer and release all resources.
	// It will clear the buffer, inflight messages, and pending acks.
	// It will also clear the write queue and close the outgoing stream.
	// If a reason is provided, it will be used to reject all pending acks and write requests.
	// If no reason is provided, it will use a default error message.
	function close(reason?: Error) {
		if (isClosed) {
			return;
		}

		dbg('closing writer, reason: %O, lastSeqNo: %O', reason, lastSeqNo);

		ac.abort();

		// Clear the buffer and inflight messages.
		buffer.clear();
		bufferSize = 0n;

		inflight.clear();
		outgoing.close();

		for (const pendingAck of pendingAcks.values()) {
			pendingAck.reject(reason || new Error('Writer closed'));
		}
		pendingAcks.clear();

		clearInterval(backgroundFlusher);
		clearInterval(backgroundTokenRefresher);

		// Clear the write queue.
		let qq = [...queue];
		queue = [];

		for (const item of qq) {
			item.reject(reason || new Error('Writer closed'));
		}

		isClosed = true;
		dbg('writer closed, reason: %O', reason);
	}

	return {
		flush,
		write,
		close,
		[Symbol.dispose]: () => {
			close(new Error('Writer disposed'));
			outgoing[Symbol.dispose]();
		},
		[Symbol.asyncDispose]: async () => {
			await flush();
			close(new Error('Writer disposed'));
			outgoing[Symbol.dispose]();
		}
	}
}
