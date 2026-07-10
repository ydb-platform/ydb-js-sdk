import type { StreamReadMessage_InitRequest_TopicReadSettings } from '@ydbjs/api/topic'
import type { Driver } from '@ydbjs/core'
import type { StringValue } from 'ms'
import type { CodecMap } from '../codec.js'
import type { TopicPartitionSession } from '../partition-session.js'
import type { TX } from '../tx.js'

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
	maxLag?: number | StringValue | import('@bufbuild/protobuf/wkt').Duration
	/**
	 * Read data only after this timestamp from this topic.
	 * Read only messages with 'written_at' value greater or equal than this timestamp.
	 */
	readFrom?: number | Date | import('@bufbuild/protobuf/wkt').Timestamp
}

export type onPartitionSessionStartCallback = (
	partitionSession: TopicPartitionSession,
	committedOffset: bigint,
	partitionOffsets: {
		start: bigint
		end: bigint
	}
) => Promise<void | undefined | { readOffset?: bigint; commitOffset?: bigint }>

export type onPartitionSessionStopCallback = (
	partitionSession: TopicPartitionSession,
	committedOffset: bigint
) => Promise<void>

export type onCommittedOffsetCallback = (
	partitionSession: TopicPartitionSession,
	committedOffset: bigint
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
	// Terminal reconnect window in ms. Unbounded by default (the reader reconnects
	// forever, waiting for the server / topic); pass a finite value to fail terminally
	// if no successful reconnect happens within it.
	recoveryWindowMs?: number
	// Retry on SCHEME_ERROR (e.g. the topic does not exist yet). Off by default: a
	// missing / mistyped topic fails fast. Enable to wait until the topic is created.
	// A running reader whose topic is dropped idles until the server closes the stale
	// stream (~1 min), then transparently reconnects: it resumes automatically if the
	// topic exists again, and with this flag also waits if the topic is recreated later.
	retryOnSchemeError?: boolean
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

// The public reader type is the `TopicReader` class itself (see reader/index.ts),
// mirroring `TopicWriter` — there is no separate interface. `TopicTxReader` stays an
// interface because a tx reader is a distinct shape (no `commit()`).
export interface TopicTxReader extends AsyncDisposable, Disposable {
	// Read messages from the topic stream within a transaction.
	read(options?: {
		limit?: number
		// Max time to accumulate a batch before yielding (possibly empty, so an idle
		// topic never hangs the consumer). Omit to block for one chunk.
		batchWindowMs?: number
		/** @deprecated renamed to `batchWindowMs`. */
		waitMs?: number
		signal?: AbortSignal
	}): AsyncIterable<import('../message.js').TopicMessage[]>
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
	// Note: outgoingQueue is reset (not recreated) on each retry
	readonly outgoingQueue: import('../queue.js').AsyncPriorityQueue<
		import('@ydbjs/api/topic').StreamReadMessage_FromClient
	>
	readonly buffer: import('@ydbjs/api/topic').StreamReadMessage_ReadResponse[]
	readonly partitionSessions: Map<bigint, TopicPartitionSession>
	readonly codecs: CodecMap

	// Buffer management
	readonly maxBufferSize: bigint
	freeBufferSize: bigint
}

export type TopicTxReaderState = TopicBaseReaderState & {
	readonly tx: TX
	readonly options: TopicReaderOptions
	// Transaction support - track read offsets for commit hook
	readonly readOffsets: Map<bigint, { firstOffset: bigint; lastOffset: bigint }> // partitionSessionId -> first and last read offsets
}

export type TopicCommitPromise = {
	partitionSessionId: bigint
	offset: bigint
	resolve: () => void
	reject: (reason?: any) => void
}
