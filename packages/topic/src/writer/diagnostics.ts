import { channel as dc } from 'node:diagnostics_channel'

import type { DriverIdentity } from '@ydbjs/core'

// Structured lifecycle events for @ydbjs/telemetry and future metrics/logs
// subscribers. Channel names follow AGENTS.md: ydb:<subsystem>.<concept>.<action>.
// The writer establishes the `topic` subsystem.

// Stamped onto every payload so multi-driver subscribers can attribute events.
export type WriterScope = {
	driver: DriverIdentity
	topic: string
	producer: string
}

let sessionStartedCh = dc('ydb:topic.writer.session.started')
let acknowledgedCh = dc('ydb:topic.writer.acknowledged')
let reconnectingCh = dc('ydb:topic.writer.reconnecting')
let closedCh = dc('ydb:topic.writer.closed')
let erroredCh = dc('ydb:topic.writer.errored')

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

// Fired per server write-response, carrying how many messages were acknowledged.
export let publishAcknowledged = function publishAcknowledged(
	scope: WriterScope,
	count: number
): void {
	if (acknowledgedCh.hasSubscribers) {
		acknowledgedCh.publish({ ...scope, count })
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

export let publishClosed = function publishClosed(scope: WriterScope): void {
	if (closedCh.hasSubscribers) {
		closedCh.publish({ ...scope })
	}
}

export let publishErrored = function publishErrored(scope: WriterScope, error: unknown): void {
	if (erroredCh.hasSubscribers) {
		erroredCh.publish({ ...scope, error })
	}
}
