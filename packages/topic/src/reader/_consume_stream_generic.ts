import { nextTick } from "node:process"
import { StatusIds_StatusCode } from "@ydbjs/api/operation"
import { TopicServiceDefinition } from "@ydbjs/api/topic"
import { loggers } from "@ydbjs/debug"
import { YDBError } from "@ydbjs/error"
import { retry } from "@ydbjs/retry"
import type { StreamReadMessage_ReadResponse } from "@ydbjs/api/topic"

import { _send_init_request } from "./_init_request.js"
import { _on_init_response } from "./_init_response.js"
import { _on_start_partition_session_request } from "./_start_partition_session_request.js"
import { _on_stop_partition_session_request } from "./_stop_partition_session_request.js"
import { _on_end_partition_session } from "./_end_partition_session.js"
import { _on_read_response } from "./_read_response.js"
import { _on_commit_offset_response } from "./_commit_offset_response.js"
import { _create_retry_config } from "./_shared.js"
import type { TopicCommitPromise, onCommittedOffsetCallback, onPartitionSessionStartCallback, onPartitionSessionStopCallback } from "./types.js"
import type { TopicPartitionSession } from "../partition-session.js"
import type { Driver } from "@ydbjs/core"
import type { AsyncPriorityQueue } from "../queue.js"
import type { StreamReadMessage_FromClient, StreamReadMessage_InitRequest_TopicReadSettings } from "@ydbjs/api/topic"

let dbg = loggers.topic.extend('reader')

interface ConsumeStreamContext {
    readonly driver: Driver
    readonly outgoingQueue: AsyncPriorityQueue<StreamReadMessage_FromClient>
    readonly controller: AbortController
    readonly consumer: string
    readonly topicsReadSettings: StreamReadMessage_InitRequest_TopicReadSettings[]
    readonly partitionSessions: Map<bigint, TopicPartitionSession>
    readonly buffer: StreamReadMessage_ReadResponse[]
    readonly disposed: boolean
    readonly onPartitionSessionStart?: onPartitionSessionStartCallback
    readonly onPartitionSessionStop?: onPartitionSessionStopCallback
    readonly onCommittedOffset?: onCommittedOffsetCallback

    // Buffer management
    freeBufferSize: bigint
    readonly maxBufferSize: bigint

    // Different state types
    readonly pendingCommits?: Map<bigint, TopicCommitPromise[]> // For regular reader
    readonly readOffsets?: Map<bigint, { firstOffset: bigint, lastOffset: bigint }> // For tx reader

    // Cleanup functions
    readonly clearStateOnRetry: () => void
    readonly handleCommitOffsetResponse?: boolean // Whether to handle commitOffsetResponse
}

export let _consume_stream_generic = async function consume_stream_generic(ctx: ConsumeStreamContext): Promise<void> {
    if (ctx.disposed) {
        return
    }

    let signal = ctx.controller.signal
    await ctx.driver.ready(signal)

    // Configure retry strategy for stream consumption
    let retryConfig = _create_retry_config(signal)

    // TODO: handle user errors (for example tx errors). Ex: use abort signal
    await retry(retryConfig, async (signal) => {
        // Clean up on signal abort
        signal.addEventListener('abort', () => {
            ctx.outgoingQueue.close();
        });

        let readerType = ctx.readOffsets ? 'tx' : 'regular'
        dbg.log('connecting to the %s stream with consumer %s', readerType, ctx.consumer);

        // If we have buffered messages, we need to clear them before connecting to the stream.
        if (ctx.buffer.length) {
            dbg.log('has %d messages in the buffer before connecting to the stream, clearing it', ctx.buffer.length)
            ctx.buffer.length = 0 // Clear the buffer before connecting to the stream
            ctx.freeBufferSize = ctx.maxBufferSize // Reset free buffer size
        }

        // Clear any existing partition sessions before reconnecting
        if (ctx.partitionSessions.size) {
            dbg.log('has %d partition sessions before connecting to the stream, stopping them', ctx.partitionSessions.size);

            for (let partitionSession of ctx.partitionSessions.values()) {
                partitionSession.stop();
            }

            ctx.partitionSessions.clear();
        }

        // Clear reader-specific state
        ctx.clearStateOnRetry()

        let stream = ctx.driver
            .createClient(TopicServiceDefinition)
            .streamRead(ctx.outgoingQueue, { signal });

        nextTick(() => {
            _send_init_request({
                queue: ctx.outgoingQueue,
                consumer: ctx.consumer,
                topicsReadSettings: ctx.topicsReadSettings,
            })
        })

        // Log all messages from server.
        let dbgrpc = dbg.extend('grpc')

        for await (let chunk of stream) {
            ctx.controller.signal.throwIfAborted();

            dbgrpc.log('receive %s with status %d', chunk.serverMessage.value?.$typeName, chunk.status)

            if (chunk.status !== StatusIds_StatusCode.SUCCESS) {
                let error = new YDBError(chunk.status, chunk.issues)
                dbg.log('received error from server: %s', error.message);
                throw error;
            }

            // Handle the server message based on type
            if (chunk.serverMessage.case === 'initResponse') {
                _on_init_response({
                    outgoingQueue: ctx.outgoingQueue,
                    freeBufferSize: ctx.freeBufferSize
                }, chunk.serverMessage.value)
            } else if (chunk.serverMessage.case === 'startPartitionSessionRequest') {
                await _on_start_partition_session_request({
                    partitionSessions: ctx.partitionSessions,
                    outgoingQueue: ctx.outgoingQueue,
                    ...(ctx.onPartitionSessionStart && { onPartitionSessionStart: ctx.onPartitionSessionStart })
                }, chunk.serverMessage.value)
            } else if (chunk.serverMessage.case === 'stopPartitionSessionRequest') {
                await _on_stop_partition_session_request({
                    partitionSessions: ctx.partitionSessions,
                    outgoingQueue: ctx.outgoingQueue,
                    buffer: ctx.buffer,
                    disposed: ctx.disposed,
                    ...(ctx.pendingCommits && { pendingCommits: ctx.pendingCommits }),
                    ...(ctx.onPartitionSessionStop && { onPartitionSessionStop: ctx.onPartitionSessionStop })
                }, chunk.serverMessage.value)
            } else if (chunk.serverMessage.case === 'endPartitionSession') {
                _on_end_partition_session({
                    partitionSessions: ctx.partitionSessions
                }, chunk.serverMessage.value)
            } else if (chunk.serverMessage.case === 'commitOffsetResponse' && ctx.handleCommitOffsetResponse) {
                _on_commit_offset_response({
                    pendingCommits: ctx.pendingCommits!,
                    partitionSessions: ctx.partitionSessions,
                    ...(ctx.onCommittedOffset && { onCommittedOffset: ctx.onCommittedOffset })
                }, chunk.serverMessage.value)
            } else if (chunk.serverMessage.case === 'readResponse') {
                _on_read_response({
                    buffer: ctx.buffer,
                    updateFreeBufferSize: (deltaBytes: bigint) => {
                        ctx.freeBufferSize += deltaBytes
                    }
                }, chunk.serverMessage.value)
            }
        }
    });
}
