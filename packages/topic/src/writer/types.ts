import type { CompressionCodec } from '../codec.js'
import type { TX } from '../tx.js'

// Status of a single message acknowledged by the server.
export type AckStatus = 'written' | 'skipped' | 'writtenInTx'

// A single server acknowledgement, flattened from StreamWriteMessage.WriteResponse.acks.
export type WriteAck = {
	seqNo: bigint
	status: AckStatus
	// Present only for 'written' acks — the partition offset the message landed at.
	offset?: bigint
}

// Optional per-message metadata accepted by write().
export type WriteExtra = {
	// User-provided sequence number. Providing it once switches the writer to
	// manual mode: every subsequent message must then also provide a seqNo.
	seqNo?: bigint
	createdAt?: Date
	metadataItems?: Record<string, Uint8Array>
}

export type TopicWriterOptions = {
	// Path to the topic to write to, e.g. "/Root/my-topic".
	topic: string
	// Producer identity. Together with seqNo it gives the server-side
	// deduplication key (producer + seqNo), which makes reconnect resends safe.
	// A unique id is generated if omitted.
	producer?: string
	// Transaction identity. When set, every write is tagged with the tx and a
	// stream error is NOT retried — it surfaces to the transaction layer.
	tx?: TX
	// Compression codec. Defaults to RAW.
	codec?: CompressionCodec

	// Pin writes to a single partition (mutually exclusive with messageGroupId).
	partitionId?: bigint
	// Route writes by message group (mutually exclusive with partitionId).
	messageGroupId?: string

	// Hard cap on the un-acknowledged bytes held in memory; write() throws when a
	// message would exceed it. Default 256MiB.
	maxBufferBytes?: bigint
	// Cap the number of un-acknowledged (in-flight) messages. Default 1000.
	maxInflightCount?: number
	// Background flush cadence in ms — bounds how long a small batch waits. Default 1000.
	flushIntervalMs?: number

	// How often to refresh the auth token on the stream. Default 60s.
	updateTokenIntervalMs?: number
	// Force-close deadline for graceful close() before pending messages are dropped.
	// JS-specific safety net; other SDKs bound this by the caller's signal only. Default 30s.
	gracefulShutdownTimeoutMs?: number
	// Terminal reconnect window in ms. Unbounded by default (the writer reconnects
	// forever, waiting for the server / topic); pass a finite value to fail terminally
	// if no successful reconnect happens within it.
	recoveryWindowMs?: number
	// Retry on SCHEME_ERROR (e.g. the topic does not exist yet). Off by default: a
	// missing / mistyped topic fails fast. Enable to wait until the topic is created.
	retryOnSchemeError?: boolean

	// Called for every acknowledged message. Errors thrown here are swallowed.
	onAck?: (seqNo: bigint, status: AckStatus) => void
}
