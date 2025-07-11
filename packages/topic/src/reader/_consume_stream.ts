import { nextTick } from "node:process"
import { StatusIds_StatusCode } from "@ydbjs/api/operation"
import { TopicServiceDefinition } from "@ydbjs/api/topic"
import { loggers } from "@ydbjs/debug"
import { YDBError } from "@ydbjs/error"
import { defaultRetryConfig, retry } from "@ydbjs/retry"

import { _send_init_request } from "./_init_request.js"
import { _on_init_response } from "./_init_response.js"
import { _on_start_partition_session_request } from "./_start_partition_session_request.js"
import { _on_stop_partition_session_request } from "./_stop_partition_session_request.js"
import { _on_end_partition_session } from "./_end_partition_session.js"
import { _on_read_response } from "./_read_response.js"
import { _on_commit_offset_response } from "./_commit_offset_response.js"
import type { TopicReaderState } from "./types.js"

let dbg = loggers.topic.extend('reader')

export let _consume_stream = async function consume_stream(state: TopicReaderState): Promise<void> {
	if (state.disposed) {
		return
	}

	let signal = state.controller.signal
	await state.driver.ready(signal)

	await retry({ ...defaultRetryConfig, signal }, async (signal) => {
		// Clean up on signal abort
		signal.addEventListener('abort', () => {
			state.outgoingQueue.close();
		});

		dbg.log('connecting to the stream with consumer %s', state.options.consumer);

		let stream = state.driver
			.createClient(TopicServiceDefinition)
			.streamRead(state.outgoingQueue, { signal });

		// If we have buffered messages, we need to clear them before connecting to the stream.
		if (state.buffer.length) {
			dbg.log('has %d messages in the buffer before connecting to the stream, clearing it', state.buffer.length)
			state.buffer.length = 0 // Clear the buffer before connecting to the stream
			state.freeBufferSize = state.maxBufferSize // Reset free buffer size
		}

		// Stop all partition sessions before connecting to the stream
		if (state.partitionSessions.size) {
			dbg.log('has %d partition sessions before connecting to the stream, stopping them', state.partitionSessions.size);

			for (let partitionSession of state.partitionSessions.values()) {
				partitionSession.stop();
			}

			state.partitionSessions.clear();
		}

		// If we have pending commits, we need to reject and drop them before connecting to the stream.
		if (state.pendingCommits.size) {
			dbg.log('has pending commits, before connecting to the stream, rejecting them');

			for (let [partitionSessionId, pendingCommits] of state.pendingCommits) {
				for (let commit of pendingCommits) {
					commit.reject(new Error(`Pending commit for partition session ${partitionSessionId} rejected before connecting to the stream`));
				}
			}

			state.pendingCommits.clear();
		}

		nextTick(() => {
			_send_init_request({
				queue: state.outgoingQueue,
				consumer: state.options.consumer,
				topicsReadSettings: state.topicsReadSettings
			})
		})

		// Log all messages from server.
		let dbgrpc = dbg.extend('grpc')

		for await (let chunk of stream) {
			state.controller.signal.throwIfAborted();

			dbgrpc.log('receive %s with status %d', chunk.serverMessage.value?.$typeName, chunk.status)

			if (chunk.status !== StatusIds_StatusCode.SUCCESS) {
				let error = new YDBError(chunk.status, chunk.issues)
				dbg.log('received error from server: %s', error.message);
				throw error;
			}

			// Handle the server message based on type
			if (chunk.serverMessage.case === 'initResponse') {
				void _on_init_response({
					outgoingQueue: state.outgoingQueue,
					freeBufferSize: state.freeBufferSize
				}, chunk.serverMessage.value)
			} else if (chunk.serverMessage.case === 'startPartitionSessionRequest') {
				void _on_start_partition_session_request({
					partitionSessions: state.partitionSessions,
					outgoingQueue: state.outgoingQueue,
					...(state.options.onPartitionSessionStart && { onPartitionSessionStart: state.options.onPartitionSessionStart })
				}, chunk.serverMessage.value)
			} else if (chunk.serverMessage.case === 'stopPartitionSessionRequest') {
				void _on_stop_partition_session_request({
					partitionSessions: state.partitionSessions,
					outgoingQueue: state.outgoingQueue,
					buffer: state.buffer,
					disposed: state.disposed,
					pendingCommits: state.pendingCommits,
					...(state.options.onPartitionSessionStop && { onPartitionSessionStop: state.options.onPartitionSessionStop })
				}, chunk.serverMessage.value)
			} else if (chunk.serverMessage.case === 'endPartitionSession') {
				void _on_end_partition_session({
					partitionSessions: state.partitionSessions
				}, chunk.serverMessage.value)
			} else if (chunk.serverMessage.case === 'commitOffsetResponse') {
				void _on_commit_offset_response({
					pendingCommits: state.pendingCommits,
					partitionSessions: state.partitionSessions,
					...(state.options.onCommittedOffset && { onCommittedOffset: state.options.onCommittedOffset })
				}, chunk.serverMessage.value)
			} else if (chunk.serverMessage.case === 'readResponse') {
				void _on_read_response({
					buffer: state.buffer,
					updateFreeBufferSize: (deltaBytes: bigint) => {
						state.freeBufferSize += deltaBytes
					}
				}, chunk.serverMessage.value)
			}
		}
	})
}
