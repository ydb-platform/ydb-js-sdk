import { channel as dc, tracingChannel } from 'node:diagnostics_channel'

import type { DriverIdentity } from '@ydbjs/core'

import type { AckStatus } from './types.js'

// Structured lifecycle signals for @ydbjs/telemetry and future metrics/traces/logs
// subscribers. Channel names follow AGENTS.md: event channels are
// `ydb:<subsystem>.<concept>.<action>`, tracing channels are
// `tracing:ydb:<subsystem>.<concept>.<operation>`. The writer owns the `topic`
// subsystem. Every payload carries `driver` so multi-driver subscribers can
// attribute it; durations/timestamps are ms.

// Stamped onto every payload so multi-driver subscribers can attribute events.
export type WriterScope = {
	driver: DriverIdentity
	topic: string
	producer: string
}

// One-shot config snapshot, published on `opened` so metrics/traces subscribers
// that join later still learn the writer's effective configuration.
export type WriterConfig = {
	codec: number
	maxInflightCount: number
	maxBufferBytes: bigint
	flushIntervalMs: number
	updateTokenIntervalMs: number
	gracefulShutdownTimeoutMs: number
	recoveryWindowMs: number
	partitionId?: bigint
	messageGroupId?: string
}

// Per-write-response breakdown, so a metrics subscriber can split written vs
// server-deduplicated (`skipped`) vs `writtenInTx` and track acked byte throughput.
export type AckBreakdown = {
	written: number
	skipped: number
	writtenInTx: number
	bytes: bigint
}

let openedCh = dc('ydb:topic.writer.opened')
let sessionStartedCh = dc('ydb:topic.writer.session.started')
let acknowledgedCh = dc('ydb:topic.writer.acknowledged')
let reconnectingCh = dc('ydb:topic.writer.reconnecting')
let closedCh = dc('ydb:topic.writer.closed')
let erroredCh = dc('ydb:topic.writer.errored')

// One flush() call → one span, so latency of the "wait until durable" barrier is
// traceable end to end (it spans batching + server acks + any reconnect in between).
let flushCh = tracingChannel<WriterScope>('tracing:ydb:topic.writer.flush')

// Fired once when the writer is created, carrying its effective configuration.
export let publishOpened = function publishOpened(scope: WriterScope, config: WriterConfig): void {
	if (openedCh.hasSubscribers) {
		openedCh.publish({ ...scope, config })
	}
}

// Fired once per (re)established write session, carrying the recovered high-water mark.
export let publishSessionStarted = function publishSessionStarted(
	scope: WriterScope,
	sessionId: string,
	lastSeqNo: bigint
): void {
	if (sessionStartedCh.hasSubscribers) {
		sessionStartedCh.publish({ ...scope, sessionId, lastSeqNo })
	}
}

// Fired per server write-response with the per-status breakdown and acked bytes.
export let publishAcknowledged = function publishAcknowledged(
	scope: WriterScope,
	acks: AckBreakdown
): void {
	if (acknowledgedCh.hasSubscribers) {
		acknowledgedCh.publish({ ...scope, ...acks })
	}
}

// Fired when the stream drops and the writer enters transparent reconnect.
export let publishReconnecting = function publishReconnecting(
	scope: WriterScope,
	attempt: number,
	error: unknown
): void {
	if (reconnectingCh.hasSubscribers) {
		reconnectingCh.publish({ ...scope, attempt, error })
	}
}

// Fired once when the writer shuts down (graceful close or destroy).
export let publishClosed = function publishClosed(scope: WriterScope): void {
	if (closedCh.hasSubscribers) {
		closedCh.publish({ ...scope })
	}
}

// Fired once when the writer fails terminally and stops — distinct from the
// transient `reconnecting` event, which keeps the writer alive.
export let publishErrored = function publishErrored(scope: WriterScope, error: unknown): void {
	if (erroredCh.hasSubscribers) {
		erroredCh.publish({ ...scope, error })
	}
}

// Wrap a flush() so it emits a `tracing:ydb:topic.writer.flush` span.
export let traceFlush = function traceFlush(
	scope: WriterScope,
	fn: () => Promise<bigint>
): Promise<bigint> {
	return flushCh.tracePromise(fn, { ...scope })
}

// Build the per-status breakdown for a write-response acknowledgment.
export let ackBreakdown = function ackBreakdown(
	acknowledgments: Map<bigint, AckStatus>,
	bytes: bigint
): AckBreakdown {
	let written = 0
	let skipped = 0
	let writtenInTx = 0
	for (let status of acknowledgments.values()) {
		if (status === 'written') {
			written += 1
		} else if (status === 'skipped') {
			skipped += 1
		} else {
			writtenInTx += 1
		}
	}
	return { written, skipped, writtenInTx, bytes }
}
