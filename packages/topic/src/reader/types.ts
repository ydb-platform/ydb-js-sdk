import type { Duration, Timestamp } from '@bufbuild/protobuf/wkt'
import type { StringValue } from 'ms'

import type { CodecMap } from '../codec.js'
import type { TopicMessage } from '../message.js'
import type { TopicPartitionSession } from '../partition-session.js'

export type TopicReaderSource = {
	// Topic path.
	path: string
	// Partitions to read from this topic; an empty / omitted list reads them all.
	partitionIds?: bigint[]
	// Skip messages older than now - maxLag. A bare number is milliseconds; zero
	// means infinite lag.
	maxLag?: number | StringValue | Duration
	// Read only messages written at or after this time. A bare number is epoch ms.
	readFrom?: number | Date | Timestamp
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
	// Topic path, or one/many sources with per-topic partitionIds/maxLag/readFrom filters.
	topic: string | TopicReaderSource | TopicReaderSource[]
	// Consumer the read session is attributed to — the server tracks committed
	// offsets per consumer.
	consumer: string
	// Codecs available for decompression. Defaults to RAW/GZIP/ZSTD (defaultCodecMap).
	codecMap?: CodecMap

	// Cap on buffered (undelivered-to-consumer) bytes — server read credit is granted
	// against it. Default 8MiB.
	maxBufferBytes?: bigint

	// How often to refresh the auth token on the stream. Default 60s.
	updateTokenIntervalMs?: number
	// Force-close deadline for graceful close() before pending commits are dropped.
	// JS-specific safety net; other SDKs bound this by the caller's signal only. Default 30s.
	gracefulShutdownTimeoutMs?: number
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

	// Called when the server assigns a partition; its return value may override
	// read/commit offsets.
	onPartitionSessionStart?: onPartitionSessionStartCallback
	// Called when the server revokes a partition — last chance to commit its offsets.
	onPartitionSessionStop?: onPartitionSessionStopCallback
	// Called after the server acknowledges a commit.
	onCommittedOffset?: onCommittedOffsetCallback
}

// Options for one read() loop — shared by TopicReader.read() and TopicTxReader.read().
export type TopicReadOptions = {
	limit?: number
	// Max time to accumulate a batch before yielding (possibly empty, so an idle
	// topic never hangs the consumer). Omit to block for one chunk.
	batchWindowMs?: number
	/** @deprecated renamed to `batchWindowMs`. */
	waitMs?: number
	signal?: AbortSignal
}

// The public reader type is the `TopicReader` class itself (see reader/reader.ts),
// mirroring `TopicWriter` — there is no separate interface. `TopicTxReader` stays an
// interface because a tx reader is a distinct shape (no `commit()`).
export interface TopicTxReader extends AsyncDisposable, Disposable {
	// Read messages from the topic stream within a transaction.
	read(options?: TopicReadOptions): AsyncIterable<TopicMessage[]>
	// Gracefully close the reader.
	close(): Promise<void>
	// Immediately destroy the reader and release all resources.
	destroy(reason?: unknown): void
}
