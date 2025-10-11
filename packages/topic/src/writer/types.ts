import type { RetryConfig } from "@ydbjs/retry"
import type { CompressionCodec } from "../codec.js"
import type { TX } from "../tx.js"

export type ThroughputSettings = {
	maxBufferBytes: bigint
	flushIntervalMs: number
	maxInflightCount: number
}

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
	// The producer name to use for writing messages.
	// If not provided, a random producer name will be generated.
	producer?: string
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
	// Default is 1000 messages.
	maxInflightCount?: number
	// The Interval in milliseconds to flush the buffer automatically.
	// If not provided, the writer will not flush the buffer automatically.
	// This is useful to ensure that the writer does not hold too many messages in memory.
	// Default is 10ms.
	flushIntervalMs?: number
	// Retry configuration for the writer.
	retryConfig?(signal: AbortSignal): RetryConfig
	// Callback that is called when writer receives an acknowledgment for a message.
	onAck?: (seqNo: bigint, status?: 'skipped' | 'written' | 'writtenInTx') => void
}

export interface TopicWriter extends AsyncDisposable {
	// Write a message to the topic.
	// Returns a promise that resolves to the sequence number of the message that was written to the topic.
	write(
		payload: Uint8Array,
		extra?: { seqNo?: bigint; createdAt?: Date; metadataItems?: Record<string, Uint8Array> }
	): bigint
	// Flush the buffer and send all messages to the topic.
	// Returns a promise that resolves to the last sequence number of the topic after flushing.
	flush(): Promise<bigint | undefined>
	// Gracefully close the writer. Stop accepting new messages and wait for existing ones to be sent.
	close(): Promise<void>
	// Immediately destroy the writer and release all resources.
	// This will stop all operations immediately without waiting for pending messages.
	destroy(reason?: Error): void
}

export interface TopicTxWriter {
	write(
		payload: Uint8Array,
		extra?: { seqNo?: bigint; createdAt?: Date; metadataItems?: Record<string, Uint8Array> }
	): bigint
	flush(): Promise<bigint | undefined>
	close(): Promise<void>
	destroy(): void
}
