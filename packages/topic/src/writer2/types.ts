import type { Driver } from "@ydbjs/core"
import type { ActorRef, CallbackSnapshot } from "xstate"
import type { CompressionCodec } from "../codec.js"
import type { TX } from "../tx.js"
import type { WriterStreamEmittedEvent, WriterStreamInput, WriterStreamReceiveEvent } from "./stream.ts"
import type { YDBDebugLogger } from "@ydbjs/debug"

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
	// The producer ID to use for writing messages.
	// If not provided, a random producer ID will be generated.
	producerId: string
	// The partition ID to use for writing messages.
	// If not provided, no guarantees on ordering or partitions to write to.
	partitionId?: bigint
	// The message group ID to use for writing messages.
	// If not provided, no guarantees on ordering or partitions to write to.
	messageGroupId?: string
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
	// How often to update the token for the writer.
	// Default is 60 seconds.
	updateTokenIntervalMs?: number
	// Timeout for graceful shutdown in milliseconds.
	// How long to wait for all messages to be sent and acknowledged before forcefully closing.
	// Default is 30 seconds.
	gracefulShutdownTimeoutMs?: number
	// Garbage collection settings for managing memory usage in high-throughput scenarios
	garbageCollection?: {
		// Number of acknowledged messages to accumulate before triggering compaction
		// Default is 1000 messages
		maxGarbageCount?: number
		// Size of acknowledged messages in bytes to accumulate before triggering compaction
		// Default is 100MB
		maxGarbageSize?: bigint
		// Force native Node.js GC after memory reclamation to immediately free memory
		// Requires Node.js --expose-gc flag. Default is false
		forceGC?: boolean
	}
}

// Context for the state machine
export type WriterContext = {
	readonly dbg: YDBDebugLogger

	readonly tx?: TX
	readonly driver: Driver
	readonly options: TopicWriterOptions
	readonly attempts: number

	// Producer and partition information
	readonly producerId: string
	readonly partitionId?: bigint
	readonly messageGroupId?: string

	// Session state
	readonly sessionId?: string

	// Message buffers - single array with sliding window approach
	readonly messages: import("@ydbjs/api/topic").StreamWriteMessage_WriteRequest_MessageData[]

	// Buffer window: [bufferStart, bufferStart + bufferLength)
	readonly bufferStart: number
	readonly bufferLength: number

	// Inflight window: [inflightStart, inflightStart + inflightLength)
	readonly inflightStart: number
	readonly inflightLength: number

	readonly bufferSize: bigint
	readonly inflightSize: bigint
	readonly garbageSize: bigint

	// Errors
	readonly lastError?: unknown

	// Reference to the stream actor
	readonly streamRef?: ActorRef<CallbackSnapshot<WriterStreamInput>, WriterStreamReceiveEvent, WriterStreamEmittedEvent> | undefined
}

export type MessageToSend = {
	data: Uint8Array
	seqNo: bigint  // Now required - TopicWriter always provides it
	createdAt?: Date
	metadataItems?: Record<string, Uint8Array>
}

// Events for the state machine
export type WriterEvents =
	// User-initiated events
	| { type: 'writer.write'; message: MessageToSend }
	| { type: 'writer.flush' }
	| { type: 'writer.close' }
	| { type: 'writer.destroy'; reason?: unknown }

	// Stream actor events (automatically sent by WriterStream)
	| WriterStreamEmittedEvent

export type WriterEmitted =
	| { type: 'writer.error'; error: unknown }
	| { type: 'writer.close'; reason?: unknown }
	| { type: 'writer.session'; sessionId: string; lastSeqNo: bigint }
	| { type: 'writer.acknowledgments'; acknowledgments: Map<bigint, 'skipped' | 'written' | 'writtenInTx'> }

export type WriterInput = {
	driver: Driver;
	options: TopicWriterOptions
}

// State machine states
export type WriterStates =
	| 'connecting'
	| 'connected'
	| 'errored'
	| 'writing'
	| 'flushing'
	| 'closing'
	| 'destroyed'
