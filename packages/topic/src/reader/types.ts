import type { StreamReadMessage_InitRequest_TopicReadSettings } from "@ydbjs/api/topic"
import type { StringValue } from "ms"
import type { Driver } from "@ydbjs/core"
import type { CodecMap } from "../codec.js"
import type { TopicPartitionSession } from "../partition-session.js"

export type TopicReaderSource = {
	/**
	 * Topic path.
	 */
	path: string
	/**
	 * Partitions that will be read by this session.
	 * If list is empty - then session will read all partitions.
	 */
	partitionIds?: bigint[]
	/**
	 * Skip all messages that has write timestamp smaller than now - max_lag.
	 * Zero means infinite lag.
	 */
	maxLag?: number | StringValue | import("@bufbuild/protobuf/wkt").Duration
	/**
	 * Read data only after this timestamp from this topic.
	 * Read only messages with 'written_at' value greater or equal than this timestamp.
	 */
	readFrom?: number | Date | import("@bufbuild/protobuf/wkt").Timestamp
}

export type onPartitionSessionStartCallback = (
	partitionSession: TopicPartitionSession,
	committedOffset: bigint,
	partitionOffsets: {
		start: bigint
		end: bigint
	}
) => Promise<void | undefined | { readOffset?: bigint, commitOffset?: bigint }>

export type onPartitionSessionStopCallback = (
	partitionSession: TopicPartitionSession,
	committedOffset: bigint,
) => Promise<void>

export type onCommittedOffsetCallback = (
	partitionSession: TopicPartitionSession,
	committedOffset: bigint,
) => void

export type TopicReaderOptions = {
	// Topic path or an array of topic sources.
	topic: string | TopicReaderSource | TopicReaderSource[]
	// Consumer name.
	consumer: string
	// Compression codecs to use for reading messages.
	codecMap?: CodecMap
	// Maximum size of the internal buffer in bytes.
	// If not provided, the default is 8MB.
	maxBufferBytes?: bigint
	// How often to update the token in milliseconds.
	updateTokenIntervalMs?: number
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

export type TopicTxReaderOptions = {
	// Topic path or an array of topic sources.
	topic: string | TopicReaderSource | TopicReaderSource[]
	// Consumer name.
	consumer: string
	// Transaction to use for reading.
	tx: import("../tx.js").TX
	// Compression codecs to use for reading messages.
	codecMap?: CodecMap
	// Maximum size of the internal buffer in bytes.
	// If not provided, the default is 8MB.
	maxBufferBytes?: bigint
	// How often to update the token in milliseconds.
	updateTokenIntervalMs?: number
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

export interface TopicReader extends AsyncDisposable {
	// Read messages from the topic stream.
	read(options?: { limit?: number, waitMs?: number, signal?: AbortSignal }): AsyncIterable<import("../message.js").TopicMessage[]>
	// Commit offsets for the provided messages.
	commit(input: import("../message.js").TopicMessage | import("../message.js").TopicMessage[]): Promise<void>
	// Gracefully close the reader.
	close(): Promise<void>
	// Immediately destroy the reader and release all resources.
	destroy(reason?: Error): void
}

export interface TopicTxReader {
	// Read messages from the topic stream within a transaction.
	read(options?: { limit?: number, waitMs?: number, signal?: AbortSignal }): AsyncIterable<import("../message.js").TopicMessage[]>
	// Gracefully close the reader.
	close(): Promise<void>
	// Immediately destroy the reader and release all resources.
	destroy(reason?: Error): void
}

export type TopicReaderState = TopicBaseReaderState & {
	readonly options: TopicReaderOptions
	readonly pendingCommits: Map<bigint, TopicCommitPromise[]>
}

export type TopicBaseReaderState = {
	readonly driver: Driver
	readonly topicsReadSettings: StreamReadMessage_InitRequest_TopicReadSettings[]

	// Control
	readonly controller: AbortController
	disposed: boolean

	// Data structures
	readonly outgoingQueue: import("../queue.js").AsyncPriorityQueue<import("@ydbjs/api/topic").StreamReadMessage_FromClient>
	readonly buffer: import("@ydbjs/api/topic").StreamReadMessage_ReadResponse[]
	readonly partitionSessions: Map<bigint, TopicPartitionSession>
	readonly codecs: CodecMap

	// Buffer management
	readonly maxBufferSize: bigint
	freeBufferSize: bigint
}

export type TopicTxReaderState = TopicBaseReaderState & {
	readonly options: TopicTxReaderOptions
	// Transaction support - track read offsets for commit hook
	readonly readOffsets: Map<bigint, { firstOffset: bigint, lastOffset: bigint }> // partitionSessionId -> first and last read offsets
}

export type TopicCommitPromise = {
	partitionSessionId: bigint
	offset: bigint
	resolve: () => void
	reject: (reason?: any) => void
}
