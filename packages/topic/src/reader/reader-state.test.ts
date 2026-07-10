import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { YDBError } from '@ydbjs/error'
import { expect, test } from 'vitest'

import {
	type ReaderCtx,
	type ReaderEffect,
	type ReaderEvent,
	type ReaderOutput,
	type ReaderState,
	createReaderCtx,
	isRetryableReaderError,
	readerTransition,
} from './reader-state.ts'

// Stateful harness: the reader transition mutates ctx, so a test threads ctx +
// state through a sequence of events, collecting emitted outputs and effects.
type Harness = {
	ctx: ReaderCtx
	state: ReaderState
	emitted: ReaderOutput[]
	effects: ReaderEffect[]
	dispatched: ReaderEvent[]
}

let mk = function mk(maxBufferBytes = 1000n): Harness {
	return {
		ctx: createReaderCtx({ maxBufferBytes }),
		state: 'idle',
		emitted: [],
		effects: [],
		dispatched: [],
	}
}

let step = function step(h: Harness, event: ReaderEvent): void {
	let runtime = {
		state: h.state,
		signal: new AbortController().signal,
		emit: (output: ReaderOutput) => h.emitted.push(output),
		dispatch: (next: ReaderEvent) => h.dispatched.push(next),
	}
	let result = readerTransition(h.ctx, event, runtime)
	if (result?.state) {
		h.state = result.state
	}
	h.effects = result?.effects ?? []
}

let effectTypes = function effectTypes(effects: ReaderEffect[]): string[] {
	return effects.map((e) => e.type)
}

let startMsg = function startMsg(
	sessionId: bigint,
	partitionId: bigint,
	committedOffset: bigint,
	partitionOffsets: { start: bigint; end: bigint } = { start: 0n, end: 100n }
): ReaderEvent {
	return {
		type: 'reader.stream.start_partition',
		partitionSessionId: sessionId,
		partitionId,
		path: '/t',
		committedOffset,
		partitionOffsets,
	}
}

let readMsg = function readMsg(
	sessionId: bigint,
	bytesSize: bigint,
	offsets: bigint[]
): ReaderEvent {
	return {
		type: 'reader.stream.read_response',
		partitionData: [
			{
				partitionSessionId: sessionId,
				batches: [
					{
						producerId: 'p',
						codec: 1,
						messageData: offsets.map((offset) => ({
							offset,
							seqNo: offset,
							data: new Uint8Array(1),
							uncompressedSize: 1n,
							metadataItems: [],
						})),
					},
				],
			},
		],
		bytesSize,
	}
}

let commitMsg = function commitMsg(pairs: [bigint, bigint][]): ReaderEvent {
	return {
		type: 'reader.stream.commit_response',
		committed: pairs.map(([partitionSessionId, committedOffset]) => ({
			partitionSessionId,
			committedOffset,
		})),
	}
}

let stopMsg = function stopMsg(
	sessionId: bigint,
	graceful: boolean,
	committedOffset = 0n
): ReaderEvent {
	return {
		type: 'reader.stream.stop_partition',
		partitionSessionId: sessionId,
		graceful,
		committedOffset,
	}
}

let endMsg = function endMsg(sessionId: bigint): ReaderEvent {
	return { type: 'reader.stream.end_partition', partitionSessionId: sessionId }
}

let message = function message(h: Harness, event: ReaderEvent): void {
	step(h, event)
}

// Drive to `ready` with one active partition (sessionId=1, partitionId=10, committed=5).
let toReadyWithPartition = function toReadyWithPartition(h: Harness): void {
	step(h, { type: 'reader.start' })
	step(h, { type: 'reader.stream.init_response', sessionId: 's1' })
	message(h, startMsg(1n, 10n, 5n))
}

let outputs = function outputs<T extends ReaderOutput['type']>(
	h: Harness,
	type: T
): Extract<ReaderOutput, { type: T }>[] {
	return h.emitted.filter((o): o is Extract<ReaderOutput, { type: T }> => o.type === type)
}

// ── lifecycle ─────────────────────────────────────────────────────────────────

test('connects on start from idle', () => {
	let h = mk()
	step(h, { type: 'reader.start' })
	expect(h.state).toBe('connecting')
	expect(effectTypes(h.effects)).toContain('reader.effect.transport.connect')
})

test('becomes ready and issues the initial full-buffer read request', () => {
	let h = mk(1000n)
	step(h, { type: 'reader.start' })
	step(h, { type: 'reader.stream.init_response', sessionId: 's1' })
	expect(h.state).toBe('ready')
	expect(outputs(h, 'reader.session')[0]).toMatchObject({ sessionId: 's1' })
	let sends = h.effects.filter((e) => e.type === 'reader.effect.send.read_request')
	expect(sends).toHaveLength(1)
})

test('reconnects on a retryable disconnect', () => {
	let h = mk()
	step(h, { type: 'reader.start' })
	step(h, { type: 'reader.stream.init_response', sessionId: 's1' })
	step(h, {
		type: 'reader.stream.disconnected',
		error: new YDBError(StatusIds_StatusCode.UNAVAILABLE, []),
	})
	expect(h.state).toBe('reconnecting')
	expect(outputs(h, 'reader.reconnecting')).toHaveLength(1)
})

test('does not arm the recovery window when reconnect is unbounded', () => {
	let h = mk() // recoveryWindowMs defaults to Infinity (unbounded)
	step(h, { type: 'reader.start' })
	step(h, { type: 'reader.stream.init_response', sessionId: 's1' })
	step(h, {
		type: 'reader.stream.disconnected',
		error: new YDBError(StatusIds_StatusCode.UNAVAILABLE, []),
	})
	expect(h.state).toBe('reconnecting')
	expect(h.effects).not.toContainEqual({
		type: 'reader.effect.timer.schedule',
		which: 'recovery_window',
	})
})

test('arms the recovery window when reconnect is bounded', () => {
	let h = mk()
	h.ctx.recoveryWindowMs = 5000
	step(h, { type: 'reader.start' })
	step(h, { type: 'reader.stream.init_response', sessionId: 's1' })
	step(h, {
		type: 'reader.stream.disconnected',
		error: new YDBError(StatusIds_StatusCode.UNAVAILABLE, []),
	})
	expect(h.state).toBe('reconnecting')
	expect(h.effects).toContainEqual({
		type: 'reader.effect.timer.schedule',
		which: 'recovery_window',
	})
})

test('errors terminally on a fatal disconnect', () => {
	let h = mk()
	step(h, { type: 'reader.start' })
	step(h, { type: 'reader.stream.init_response', sessionId: 's1' })
	step(h, {
		type: 'reader.stream.disconnected',
		error: new YDBError(StatusIds_StatusCode.SCHEME_ERROR, []),
	})
	expect(h.state).toBe('errored')
	expect(outputs(h, 'reader.error')).toHaveLength(1)
})

test('classifies SCHEME_ERROR as retryable when retryOnSchemeError is set', () => {
	expect(isRetryableReaderError(new YDBError(StatusIds_StatusCode.SCHEME_ERROR, []), true)).toBe(
		true
	)
})

test('reconnects instead of erroring on SCHEME_ERROR when retryOnSchemeError is set', () => {
	let h = mk()
	h.ctx.retryOnSchemeError = true
	step(h, { type: 'reader.start' })
	step(h, { type: 'reader.stream.init_response', sessionId: 's1' })
	step(h, {
		type: 'reader.stream.disconnected',
		error: new YDBError(StatusIds_StatusCode.SCHEME_ERROR, []),
	})
	expect(h.state).toBe('reconnecting')
	expect(outputs(h, 'reader.reconnecting')).toHaveLength(1)
})

// ── partition lifecycle ─────────────────────────────────────────────────────────

test('registers a partition and acks the start on StartPartitionSession', () => {
	let h = mk()
	toReadyWithPartition(h)
	expect(h.ctx.partitions.get(10n)).toBeDefined()
	expect(h.ctx.sessionIndex.get(1n)).toBe(10n)
	expect(outputs(h, 'reader.partition.started')[0]).toMatchObject({
		partitionId: 10n,
		committedOffset: 5n,
	})
	expect(effectTypes(h.effects)).toContain('reader.effect.partition.start_ack')
})

test('initializes gap-fill anchor from the server committed offset', () => {
	let h = mk()
	toReadyWithPartition(h)
	expect(h.ctx.partitions.get(10n)!.nextCommitStartOffset).toBe(5n)
})

test('delivers messages and charges the flow-control budget', () => {
	let h = mk()
	toReadyWithPartition(h)
	h.emitted.length = 0
	message(h, readMsg(1n, 300n, [5n, 6n, 7n]))
	let delivered = outputs(h, 'reader.messages')
	expect(delivered).toHaveLength(1)
	expect(delivered[0]!.groups[0]!.messages.map((m) => m.offset)).toEqual([5n, 6n, 7n])
	expect(delivered[0]!.releaseBytes).toBe(300n)
	expect(h.ctx.inFlightBytes).toBe(300n)
})

test('releases credit but drops data for an unknown session', () => {
	let h = mk()
	toReadyWithPartition(h)
	h.emitted.length = 0
	message(h, readMsg(999n, 300n, [1n]))
	let delivered = outputs(h, 'reader.messages')
	expect(delivered).toHaveLength(1)
	expect(delivered[0]!.groups).toHaveLength(0)
	expect(delivered[0]!.releaseBytes).toBe(300n) // credit still released -> no stall
})

test('charges a multi-partition read response only once', () => {
	let h = mk(5000n)
	step(h, { type: 'reader.start' })
	step(h, { type: 'reader.stream.init_response', sessionId: 's1' })
	message(h, startMsg(1n, 10n, 0n))
	message(h, startMsg(2n, 20n, 0n))
	h.emitted.length = 0
	message(h, {
		type: 'reader.stream.read_response',
		partitionData: [
			{
				partitionSessionId: 1n,
				batches: [
					{
						producerId: 'p',
						codec: 1,
						messageData: [
							{
								offset: 0n,
								seqNo: 0n,
								data: new Uint8Array(1),
								uncompressedSize: 1n,
								metadataItems: [],
							},
						],
					},
				],
			},
			{
				partitionSessionId: 2n,
				batches: [
					{
						producerId: 'p',
						codec: 1,
						messageData: [
							{
								offset: 0n,
								seqNo: 0n,
								data: new Uint8Array(1),
								uncompressedSize: 1n,
								metadataItems: [],
							},
						],
					},
				],
			},
		],
		bytesSize: 1000n,
	})
	let delivered = outputs(h, 'reader.messages')
	expect(delivered).toHaveLength(1)
	expect(delivered[0]!.groups).toHaveLength(2)
	expect(delivered[0]!.releaseBytes).toBe(1000n) // once, not 1000 per partition
	expect(h.ctx.inFlightBytes).toBe(1000n)
})

test('drops the superseded session id from the index on reassign', () => {
	let h = mk()
	toReadyWithPartition(h) // session 1 -> partition 10
	step(h, {
		type: 'reader.stream.disconnected',
		error: new YDBError(StatusIds_StatusCode.UNAVAILABLE, []),
	})
	step(h, { type: 'reader.timer.retry_backoff' })
	step(h, { type: 'reader.stream.init_response', sessionId: 's2' })
	message(h, startMsg(2n, 10n, 5n)) // reassign -> session 2
	expect(h.ctx.sessionIndex.has(1n)).toBe(false) // stale id gone
	expect(h.ctx.sessionIndex.get(2n)).toBe(10n)
	expect(h.ctx.sessionIndex.size).toBe(1)
	// late data on the dead session id must be dropped (never routed to session 2)
	h.emitted.length = 0
	message(h, readMsg(1n, 100n, [5n]))
	expect(outputs(h, 'reader.messages')[0]!.groups).toHaveLength(0)
})

test('ends a partition session without a response', () => {
	let h = mk()
	toReadyWithPartition(h)
	message(h, endMsg(1n))
	expect(h.ctx.partitions.get(10n)!.state).toBe('ended')
	expect(h.ctx.partitions.get(10n)!.session.isEnded).toBe(true)
})

// ── commit ──────────────────────────────────────────────────────────────────────

test('sends a commit with a gap-filled first range', () => {
	let h = mk()
	toReadyWithPartition(h) // committed=5 -> nextCommitStartOffset=5
	// commit offset 8 (messages 5,6,7 deleted by retention): range must be [5, 9).
	step(h, { type: 'reader.commit', partitionId: 10n, offsets: [8n], waiterId: 1 })
	let send = h.effects.find((e) => e.type === 'reader.effect.send.commit')
	expect(send).toBeDefined()
	let entry = h.ctx.partitions.get(10n)!
	expect(entry.pendingCommits[0]).toMatchObject({ startOffset: 5n, endOffset: 9n, waiterId: 1 })
	expect(entry.nextCommitStartOffset).toBe(9n)
})

test('resolves a commit on a covering commit-offset response', () => {
	let h = mk()
	toReadyWithPartition(h)
	step(h, { type: 'reader.commit', partitionId: 10n, offsets: [8n], waiterId: 1 })
	h.emitted.length = 0
	message(h, commitMsg([[1n, 9n]]))
	expect(outputs(h, 'reader.commit.resolved')[0]).toMatchObject({ waiterId: 1 })
	expect(h.ctx.partitions.get(10n)!.pendingCommits).toHaveLength(0)
})

test('keeps a commit pending until the high-water mark reaches its end', () => {
	let h = mk()
	toReadyWithPartition(h)
	step(h, { type: 'reader.commit', partitionId: 10n, offsets: [8n], waiterId: 1 }) // [5,9)
	h.emitted.length = 0
	message(h, commitMsg([[1n, 7n]])) // below endOffset 9
	expect(outputs(h, 'reader.commit.resolved')).toHaveLength(0)
	expect(h.ctx.partitions.get(10n)!.pendingCommits).toHaveLength(1)
})

// ── reconnect reconcile (THE CRUX) ────────────────────────────────────────────────

test('re-sends an unacked commit on the new session after reconnect', () => {
	let h = mk()
	toReadyWithPartition(h) // session 1, committed 5
	step(h, { type: 'reader.commit', partitionId: 10n, offsets: [8n], waiterId: 1 }) // pending [5,9)
	// reconnect
	step(h, {
		type: 'reader.stream.disconnected',
		error: new YDBError(StatusIds_StatusCode.UNAVAILABLE, []),
	})
	step(h, { type: 'reader.timer.retry_backoff' })
	step(h, { type: 'reader.stream.init_response', sessionId: 's2' })
	h.emitted.length = 0
	h.effects = []
	// server re-sends Start for the same partition, still committed at 5 (commit lost)
	message(h, startMsg(2n, 10n, 5n))
	// the pending [5,9) must be re-sent on the NEW session id (2)
	let commitSend = h.effects.find(
		(e): e is Extract<ReaderEffect, { type: 'reader.effect.send.commit' }> =>
			e.type === 'reader.effect.send.commit'
	)
	expect(commitSend).toBeDefined()
	// re-sent on the NEW session id (2) with the narrowed range [5, 9)
	expect(commitSend!.partitionSessionId).toBe(2n)
	expect(commitSend!.ranges).toEqual([{ start: 5n, end: 9n }])
	expect(h.ctx.partitions.get(10n)!.pendingCommits).toHaveLength(1)
	expect(outputs(h, 'reader.commit.resolved')).toHaveLength(0)
})

test('resolves a pending commit that the server committed before the reconnect', () => {
	let h = mk()
	toReadyWithPartition(h)
	step(h, { type: 'reader.commit', partitionId: 10n, offsets: [8n], waiterId: 1 }) // [5,9)
	step(h, {
		type: 'reader.stream.disconnected',
		error: new YDBError(StatusIds_StatusCode.UNAVAILABLE, []),
	})
	step(h, { type: 'reader.timer.retry_backoff' })
	step(h, { type: 'reader.stream.init_response', sessionId: 's2' })
	h.emitted.length = 0
	// server now reports committed 9 (the commit made it durable before the drop)
	message(h, startMsg(2n, 10n, 9n))
	expect(outputs(h, 'reader.commit.resolved')[0]).toMatchObject({ waiterId: 1 })
	expect(h.ctx.partitions.get(10n)!.pendingCommits).toHaveLength(0)
})

test('never rejects a pending commit merely because the stream reconnected', () => {
	let h = mk()
	toReadyWithPartition(h)
	step(h, { type: 'reader.commit', partitionId: 10n, offsets: [8n], waiterId: 1 })
	step(h, {
		type: 'reader.stream.disconnected',
		error: new YDBError(StatusIds_StatusCode.UNAVAILABLE, []),
	})
	step(h, { type: 'reader.timer.retry_backoff' })
	step(h, { type: 'reader.stream.init_response', sessionId: 's2' })
	expect(outputs(h, 'reader.commit.rejected')).toHaveLength(0)
})

// ── stop ──────────────────────────────────────────────────────────────────────

test('holds pending commits on a non-graceful stop and schedules a gc timer', () => {
	let h = mk()
	toReadyWithPartition(h)
	step(h, { type: 'reader.commit', partitionId: 10n, offsets: [8n], waiterId: 1 })
	h.emitted.length = 0
	message(h, stopMsg(1n, false))
	expect(h.ctx.partitions.get(10n)!.state).toBe('stopped')
	expect(h.ctx.partitions.get(10n)!.pendingCommits).toHaveLength(1) // held, not rejected
	expect(outputs(h, 'reader.commit.rejected')).toHaveLength(0)
	expect(effectTypes(h.effects)).toContain('reader.effect.timer.schedule')
})

test('responds immediately to a graceful stop with no pending commits', () => {
	let h = mk()
	toReadyWithPartition(h)
	h.emitted.length = 0
	message(h, stopMsg(1n, true))
	let send = h.effects.find(
		(e): e is Extract<ReaderEffect, { type: 'reader.effect.send.stop_response' }> =>
			e.type === 'reader.effect.send.stop_response'
	)
	expect(send).toBeDefined()
	expect(send!.partitionSessionId).toBe(1n)
	expect(h.ctx.partitions.get(10n)!.state).toBe('stopped')
})

test('rejects held commits when a stopped partition is gc-reassigned', () => {
	let h = mk()
	toReadyWithPartition(h)
	step(h, { type: 'reader.commit', partitionId: 10n, offsets: [8n], waiterId: 1 })
	message(h, stopMsg(1n, false))
	h.emitted.length = 0
	step(h, { type: 'reader.timer.partition_reassign_gc', partitionId: 10n })
	expect(outputs(h, 'reader.commit.rejected')[0]).toMatchObject({ waiterId: 1 })
	expect(h.ctx.partitions.has(10n)).toBe(false)
})

// ── flow-control ────────────────────────────────────────────────────────────────

test('replenishes read credit once released bytes cross the threshold', () => {
	let h = mk(1000n) // threshold ~200
	toReadyWithPartition(h)
	message(h, readMsg(1n, 300n, [5n]))
	h.effects = []
	step(h, { type: 'reader.read_release', bytes: 150n })
	expect(h.effects).toHaveLength(0) // below threshold
	step(h, { type: 'reader.read_release', bytes: 100n })
	let send = h.effects.find(
		(e): e is Extract<ReaderEffect, { type: 'reader.effect.send.read_request' }> =>
			e.type === 'reader.effect.send.read_request'
	)
	expect(send).toBeDefined()
	expect(send!.bytesSize).toBe(250n)
	expect(h.ctx.inFlightBytes).toBe(50n)
	expect(h.ctx.pendingReadRequestBytes).toBe(0n)
})

test('resets flow-control on reconnect init', () => {
	let h = mk(1000n)
	toReadyWithPartition(h)
	message(h, readMsg(1n, 400n, [5n]))
	expect(h.ctx.inFlightBytes).toBe(400n)
	step(h, {
		type: 'reader.stream.disconnected',
		error: new YDBError(StatusIds_StatusCode.UNAVAILABLE, []),
	})
	step(h, { type: 'reader.timer.retry_backoff' })
	step(h, { type: 'reader.stream.init_response', sessionId: 's2' })
	expect(h.ctx.inFlightBytes).toBe(0n)
	expect(h.ctx.sessionIndex.size).toBe(0)
})

// (tx read-offset tracking moved to the facade — the FSM is now tx-agnostic; covered
// by reader.contract.test.ts and the e2e tx tests.)

// ── terminal ──────────────────────────────────────────────────────────────────

test('destroy rejects outstanding commits exactly once and terminates', () => {
	let h = mk()
	toReadyWithPartition(h)
	step(h, { type: 'reader.commit', partitionId: 10n, offsets: [8n], waiterId: 1 })
	h.emitted.length = 0
	step(h, { type: 'reader.destroy', reason: new Error('boom') })
	expect(h.state).toBe('closed')
	expect(outputs(h, 'reader.commit.rejected').filter((r) => r.waiterId === 1)).toHaveLength(1)
	expect(outputs(h, 'reader.closed')).toHaveLength(1)
	expect(h.ctx.partitions.size).toBe(0)
})

test('closes immediately when nothing is pending', () => {
	let h = mk()
	toReadyWithPartition(h)
	step(h, { type: 'reader.close' })
	expect(h.state).toBe('closed')
})

test('waits for pending commits before closing', () => {
	let h = mk()
	toReadyWithPartition(h)
	step(h, { type: 'reader.commit', partitionId: 10n, offsets: [8n], waiterId: 1 })
	step(h, { type: 'reader.close' })
	expect(h.state).toBe('closing')
	// draining the commit lets it finish
	message(h, commitMsg([[1n, 9n]]))
	expect(h.state).toBe('closed')
})
