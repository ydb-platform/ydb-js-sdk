import { channel as dc, tracingChannel } from 'node:diagnostics_channel'

import type { DriverIdentity } from '@ydbjs/core'

// Structured lifecycle signals for @ydbjs/telemetry and future metrics/traces/logs
// subscribers. Channel names follow AGENTS.md: `ydb:<subsystem>.<concept>.<action>`
// for events and `tracing:ydb:<subsystem>.<concept>.<operation>` for spans. The reader
// owns the `topic` subsystem alongside the writer. Every payload carries `driver` so
// multi-driver subscribers can attribute events; durations/timestamps are ms.

// Stamped onto every payload so multi-driver subscribers can attribute events.
export type ReaderScope = {
	driver: DriverIdentity
	consumer: string
	topics: string[]
}

// One-shot config snapshot, published on `opened` so late-joining subscribers still
// learn the reader's effective configuration.
export type ReaderConfig = {
	maxBufferBytes: bigint
	updateTokenIntervalMs: number
	gracefulShutdownTimeoutMs: number
	recoveryWindowMs: number
	retryOnSchemeError: boolean
}

let openedCh = dc('ydb:topic.reader.opened')
let sessionStartedCh = dc('ydb:topic.reader.session.started')
let partitionStartedCh = dc('ydb:topic.reader.partition.started')
let partitionStoppedCh = dc('ydb:topic.reader.partition.stopped')
let committedCh = dc('ydb:topic.reader.committed')
let reconnectingCh = dc('ydb:topic.reader.reconnecting')
let closedCh = dc('ydb:topic.reader.closed')
let erroredCh = dc('ydb:topic.reader.errored')

// One commit() call → one span (batching + server ack + any reconnect in between).
let commitCh = tracingChannel<ReaderScope>('tracing:ydb:topic.reader.commit')

// Every helper below guards with hasSubscribers before publish(). publish() itself
// is a no-op without subscribers, but its argument is built before the call — the
// guard skips that payload allocation (same rule as `if (dbg.enabled)` for logs).
export let publishOpened = function publishOpened(scope: ReaderScope, config: ReaderConfig): void {
	if (openedCh.hasSubscribers) {
		openedCh.publish({ ...scope, config })
	}
}

// Fired once per (re)established read session.
export let publishSessionStarted = function publishSessionStarted(
	scope: ReaderScope,
	sessionId: string
): void {
	if (sessionStartedCh.hasSubscribers) {
		sessionStartedCh.publish({ ...scope, sessionId })
	}
}

export let publishPartitionStarted = function publishPartitionStarted(
	scope: ReaderScope,
	partitionId: bigint,
	partitionSessionId: bigint,
	committedOffset: bigint
): void {
	if (partitionStartedCh.hasSubscribers) {
		partitionStartedCh.publish({ ...scope, partitionId, partitionSessionId, committedOffset })
	}
}

export let publishPartitionStopped = function publishPartitionStopped(
	scope: ReaderScope,
	partitionId: bigint,
	reason: 'graceful' | 'lost' | 'ended'
): void {
	if (partitionStoppedCh.hasSubscribers) {
		partitionStoppedCh.publish({ ...scope, partitionId, reason })
	}
}

export let publishCommitted = function publishCommitted(
	scope: ReaderScope,
	partitionId: bigint,
	committedOffset: bigint
): void {
	if (committedCh.hasSubscribers) {
		committedCh.publish({ ...scope, partitionId, committedOffset })
	}
}

export let publishReconnecting = function publishReconnecting(
	scope: ReaderScope,
	attempt: number,
	error: unknown
): void {
	if (reconnectingCh.hasSubscribers) {
		reconnectingCh.publish({ ...scope, attempt, error })
	}
}

export let publishClosed = function publishClosed(scope: ReaderScope): void {
	if (closedCh.hasSubscribers) {
		closedCh.publish({ ...scope })
	}
}

export let publishErrored = function publishErrored(scope: ReaderScope, error: unknown): void {
	if (erroredCh.hasSubscribers) {
		erroredCh.publish({ ...scope, error })
	}
}

// Wrap a commit() so it emits a `tracing:ydb:topic.reader.commit` span.
export let traceCommit = function traceCommit(
	scope: ReaderScope,
	fn: () => Promise<void>
): Promise<void> {
	return commitCh.tracePromise(fn, { ...scope })
}
