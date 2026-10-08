import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { YDBError } from '@ydbjs/error'
import { expect, test } from 'vitest'

import {
	type OffsetRange,
	type ReaderCtx,
	type ReaderEffect,
	type ReaderEvent,
	type ReaderOutput,
	type ReaderState,
	createReaderCtx,
	isRetryableReaderError,
	partitionKey,
	readerTransition,
} from './reader-state.ts'

// Stateful harness: the reader transition mutates ctx, so a test threads ctx +
// state through a sequence of events, collecting emitted outputs and effects.
type Harness = {
	ctx: ReaderCtx
	state: ReaderState
	emitted: ReaderOutput[]
	effects: ReaderEffect[]
	allEffects: ReaderEffect[]
	dispatched: ReaderEvent[]
}

let mk = function mk(maxBufferBytes = 1000n): Harness {
	return {
		ctx: createReaderCtx({ maxBufferBytes }),
		state: 'idle',
		emitted: [],
		effects: [],
		allEffects: [],
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
	h.allEffects.push(...h.effects)
}

let effectTypes = function effectTypes(effects: ReaderEffect[]): string[] {
	return effects.map((e) => e.type)
}

// Single-topic fixtures live on '/t'.
let pk = function pk(partitionId: bigint): string {
	return partitionKey('/t', partitionId)
}

let startMsg = function startMsg(
	sessionId: bigint,
	partitionId: bigint,
	committedOffset: bigint,
	path = '/t',
	partitionOffsets: OffsetRange = { start: 0n, end: 100n }
): ReaderEvent {
	return {
		type: 'reader.stream.start_partition',
		partitionSessionId: sessionId,
		partitionId,
		path,
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

let endMsg = function endMsg(
	sessionId: bigint,
	childPartitionIds: bigint[] = [],
	adjacentPartitionIds: bigint[] = []
): ReaderEvent {
	return {
		type: 'reader.stream.end_partition',
		partitionSessionId: sessionId,
		childPartitionIds,
		adjacentPartitionIds,
	}
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

// The facade precomputes merged half-open ranges from the messages' stitched
// commit-range starts; the transition sees only ranges.
let commit = function commit(
	h: Harness,
	partitionId: bigint,
	ranges: OffsetRange[],
	waiterId: number
): void {
	step(h, { type: 'reader.commit', partitionKey: pk(partitionId), ranges, waiterId })
}

// Complete the async start handshake for the partition's CURRENT grant — until the
// ack, commits buffer (ackPending) instead of hitting the wire.
let ackStart = function ackStart(h: Harness, sessionId: bigint, partitionId: bigint): void {
	step(h, {
		type: 'reader.partition.start_ready',
		partitionSessionId: sessionId,
		partitionKey: pk(partitionId),
		grantId: h.ctx.partitions.get(pk(partitionId))!.grantId,
	})
}

// Complete the async stop hook for the partition's CURRENT grant.
let ackStop = function ackStop(h: Harness, partitionId: bigint): void {
	step(h, {
		type: 'reader.partition.stop_ready',
		partitionKey: pk(partitionId),
		grantId: h.ctx.partitions.get(pk(partitionId))!.grantId,
	})
}

let commitSends = function commitSends(effects: ReaderEffect[]) {
	return effects.filter(
		(e): e is Extract<ReaderEffect, { type: 'reader.effect.send.commit' }> =>
			e.type === 'reader.effect.send.commit'
	)
}

let stopResponses = function stopResponses(effects: ReaderEffect[]) {
	return effects.filter(
		(e): e is Extract<ReaderEffect, { type: 'reader.effect.send.stop_response' }> =>
			e.type === 'reader.effect.send.stop_response'
	)
}

let startResponses = function startResponses(effects: ReaderEffect[]) {
	return effects.filter(
		(e): e is Extract<ReaderEffect, { type: 'reader.effect.send.start_response' }> =>
			e.type === 'reader.effect.send.start_response'
	)
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

test('builds a collision-free partition key from the topic path and partition id', () => {
	// '|' cannot appear in a YDB scheme path, so the composite key is unambiguous.
	expect(partitionKey('/topic', 7n)).toBe('/topic|7')
})

test('registers a partition under its composite key and runs the start hook', () => {
	let h = mk()
	toReadyWithPartition(h)
	expect(h.ctx.partitions.get(pk(10n))).toBeDefined()
	expect(h.ctx.sessionIndex.get(1n)).toBe(pk(10n))
	let started = outputs(h, 'reader.partition.started')
	expect(started[0]).toMatchObject({
		partitionId: 10n,
		partitionSessionId: 1n,
		committedOffset: 5n,
	})
	expect(started[0]!.session.partitionSessionId).toBe(1n)
	expect(effectTypes(h.effects)).toContain('reader.effect.partition.start_hook')
})

test('keys same-numbered partitions from different topics separately', () => {
	let h = mk(5000n)
	step(h, { type: 'reader.start' })
	step(h, { type: 'reader.stream.init_response', sessionId: 's1' })
	// partition_id is per-topic: a multi-topic reader routinely sees the same id from
	// several topics, so only the (path, partitionId) pair may key the registry.
	message(h, startMsg(1n, 1n, 0n, '/a'))
	message(h, startMsg(2n, 1n, 0n, '/b'))
	expect(h.ctx.partitions.size).toBe(2)
	expect(h.ctx.sessionIndex.get(1n)).toBe(partitionKey('/a', 1n))
	expect(h.ctx.sessionIndex.get(2n)).toBe(partitionKey('/b', 1n))
	step(h, {
		type: 'reader.partition.start_ready',
		partitionSessionId: 1n,
		partitionKey: partitionKey('/a', 1n),
		grantId: h.ctx.partitions.get(partitionKey('/a', 1n))!.grantId,
	})
	step(h, {
		type: 'reader.commit',
		partitionKey: partitionKey('/a', 1n),
		ranges: [{ start: 0n, end: 1n }],
		waiterId: 1,
	})
	let cs = commitSends(h.effects)
	expect(cs).toHaveLength(1)
	expect(cs[0]!.partitionSessionId).toBe(1n)
})

test('initializes the delivery watermark from the server committed offset', () => {
	let h = mk()
	toReadyWithPartition(h)
	expect(h.ctx.partitions.get(pk(10n))!.deliveredWatermark).toBe(5n)
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

test('stitches the head gap into the first delivered message commit range', () => {
	let h = mk()
	toReadyWithPartition(h) // committed=5
	h.emitted.length = 0
	// Offsets 5..7 are gone server-side (retention / readFrom skip): the hole must be
	// committable through message 8's range, or committing everything delivered would
	// still leave the consumer parked behind an uncommittable gap.
	message(h, readMsg(1n, 100n, [8n]))
	let msg = outputs(h, 'reader.messages')[0]!.groups[0]!.messages[0]!
	expect(msg.offset).toBe(8n)
	expect(msg.commitRangeStart).toBe(5n)
	expect(h.ctx.partitions.get(pk(10n))!.deliveredWatermark).toBe(9n)
})

test('stitches an inter-message hole to the next delivered message', () => {
	let h = mk()
	toReadyWithPartition(h)
	h.emitted.length = 0
	message(h, readMsg(1n, 100n, [5n]))
	message(h, readMsg(1n, 100n, [8n]))
	let groups = outputs(h, 'reader.messages').flatMap((o) => o.groups)
	expect(groups[0]!.messages[0]!.commitRangeStart).toBe(5n)
	// The hole [6,8) belongs to message 8; offset 5 is delivered-but-unacked and must
	// never be covered by another message's range.
	expect(groups[1]!.messages[0]!.commitRangeStart).toBe(6n)
})

test('restarts stitching from the committed offset on redelivery after a re-grant', () => {
	let h = mk()
	toReadyWithPartition(h)
	message(h, readMsg(1n, 100n, [5n, 6n]))
	expect(h.ctx.partitions.get(pk(10n))!.deliveredWatermark).toBe(7n)
	step(h, {
		type: 'reader.stream.disconnected',
		error: new YDBError(StatusIds_StatusCode.UNAVAILABLE, []),
	})
	step(h, { type: 'reader.timer.retry_backoff' })
	step(h, { type: 'reader.stream.init_response', sessionId: 's2' })
	message(h, startMsg(2n, 10n, 5n))
	expect(h.ctx.partitions.get(pk(10n))!.deliveredWatermark).toBe(5n)
	h.emitted.length = 0
	message(h, readMsg(2n, 100n, [5n]))
	let msg = outputs(h, 'reader.messages')[0]!.groups[0]!.messages[0]!
	expect(msg.commitRangeStart).toBe(5n)
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
	expect(h.ctx.sessionIndex.get(2n)).toBe(pk(10n))
	expect(h.ctx.sessionIndex.size).toBe(1)
	// late data on the dead session id must be dropped (never routed to session 2)
	h.emitted.length = 0
	message(h, readMsg(1n, 100n, [5n]))
	expect(outputs(h, 'reader.messages')[0]!.groups).toHaveLength(0)
})

test('ends a partition session without a response', () => {
	let h = mk()
	toReadyWithPartition(h)
	h.emitted.length = 0
	message(h, endMsg(1n))
	expect(h.ctx.partitions.get(pk(10n))!.state).toBe('ended')
	expect(h.ctx.partitions.get(pk(10n))!.session.isEnded).toBe(true)
	expect(outputs(h, 'reader.partition.stopped')[0]).toMatchObject({
		partitionId: 10n,
		reason: 'ended',
	})
})

test('records child and adjacent partition ids when the session ends', () => {
	let h = mk()
	toReadyWithPartition(h)
	message(h, endMsg(1n, [20n, 21n], [3n]))
	let session = h.ctx.partitions.get(pk(10n))!.session
	expect(session.childPartitionIds).toEqual([20n, 21n])
	expect(session.adjacentPartitionIds).toEqual([3n])
})

// ── commit ──────────────────────────────────────────────────────────────────────

test('sends the commit ranges verbatim and records the pending commit', () => {
	let h = mk()
	toReadyWithPartition(h) // committed=5
	// complete the start handshake — commits only hit the wire once the grant is acked
	ackStart(h, 1n, 10n)
	// The facade already stitched the retention hole [5,8) into message 8's range.
	commit(h, 10n, [{ start: 5n, end: 9n }], 1)
	let cs = commitSends(h.effects)
	expect(cs).toHaveLength(1)
	expect(cs[0]!.ranges).toEqual([{ start: 5n, end: 9n }])
	let entry = h.ctx.partitions.get(pk(10n))!
	expect(entry.pendingCommits).toEqual([
		{ targetOffset: 9n, wireRanges: [{ start: 5n, end: 9n }], waiterId: 1 },
	])
	expect(entry.claimedRanges).toEqual([{ start: 5n, end: 9n }])
})

test('clamps a commit range below the server committed offset', () => {
	let h = mk()
	toReadyWithPartition(h) // committed=5
	ackStart(h, 1n, 10n)
	// A range dipping below server truth must be clamped: a rewound range on the wire
	// is session-fatal (BAD_REQUEST "double committing is forbidden").
	commit(h, 10n, [{ start: 3n, end: 9n }], 1)
	let cs = commitSends(h.effects)
	expect(cs).toHaveLength(1)
	expect(cs[0]!.ranges).toEqual([{ start: 5n, end: 9n }])
})

test('resolves without a wire send when the range is fully below the committed offset', () => {
	let h = mk()
	toReadyWithPartition(h)
	ackStart(h, 1n, 10n)
	// Double-commit of already-committed offsets (a common at-least-once retry):
	// resolve immediately — a zero-width range on the wire is session-fatal.
	commit(h, 10n, [{ start: 0n, end: 5n }], 7)
	expect(commitSends(h.effects)).toHaveLength(0)
	expect(outputs(h, 'reader.commit.resolved').map((o) => o.waiterId)).toEqual([7])
	expect(h.ctx.partitions.get(pk(10n))!.pendingCommits).toHaveLength(0)
})

test('waits for the server watermark when the range is fully claimed by an earlier commit', () => {
	let h = mk()
	toReadyWithPartition(h)
	ackStart(h, 1n, 10n)
	commit(h, 10n, [{ start: 5n, end: 7n }], 1)
	expect(commitSends(h.effects)).toHaveLength(1)
	// Re-sending offsets already on the wire is session-fatal, but claimed coverage is
	// not durable yet: the duplicate waits without producing another wire request.
	commit(h, 10n, [{ start: 5n, end: 7n }], 2)
	expect(commitSends(h.effects)).toHaveLength(0)
	expect(outputs(h, 'reader.commit.resolved')).toHaveLength(0)
	expect(h.ctx.partitions.get(pk(10n))!.pendingCommits).toEqual([
		{ targetOffset: 7n, wireRanges: [{ start: 5n, end: 7n }], waiterId: 1 },
		{ targetOffset: 7n, wireRanges: [], waiterId: 2 },
	])

	h.emitted.length = 0
	message(h, commitMsg([[1n, 7n]]))
	expect(outputs(h, 'reader.commit.resolved').map((o) => o.waiterId)).toEqual([1, 2])
})

test('subtracts claimed coverage and sends only the remainder', () => {
	let h = mk()
	toReadyWithPartition(h)
	ackStart(h, 1n, 10n)
	commit(h, 10n, [{ start: 5n, end: 6n }], 1)
	commit(h, 10n, [{ start: 5n, end: 8n }], 2)
	let cs = commitSends(h.effects)
	expect(cs).toHaveLength(1)
	expect(cs[0]!.ranges).toEqual([{ start: 6n, end: 8n }])
	let entry = h.ctx.partitions.get(pk(10n))!
	expect(entry.pendingCommits[1]).toEqual({
		targetOffset: 8n,
		wireRanges: [{ start: 6n, end: 8n }],
		waiterId: 2,
	})
	expect(entry.claimedRanges).toEqual([{ start: 5n, end: 8n }])
})

test('merges overlapping and adjacent input ranges before the send', () => {
	let h = mk()
	toReadyWithPartition(h)
	ackStart(h, 1n, 10n)
	commit(
		h,
		10n,
		[
			{ start: 9n, end: 10n },
			{ start: 5n, end: 6n },
			{ start: 6n, end: 7n },
		],
		1
	)
	let cs = commitSends(h.effects)
	expect(cs).toHaveLength(1)
	expect(cs[0]!.ranges).toEqual([
		{ start: 5n, end: 7n },
		{ start: 9n, end: 10n },
	])
})

test('resolves a commit on a covering commit-offset response', () => {
	let h = mk()
	toReadyWithPartition(h)
	commit(h, 10n, [{ start: 5n, end: 9n }], 1)
	h.emitted.length = 0
	message(h, commitMsg([[1n, 9n]]))
	expect(outputs(h, 'reader.commit.resolved')[0]).toMatchObject({ waiterId: 1 })
	expect(h.ctx.partitions.get(pk(10n))!.pendingCommits).toHaveLength(0)
})

test('keeps a commit pending until the high-water mark reaches its end', () => {
	let h = mk()
	toReadyWithPartition(h)
	commit(h, 10n, [{ start: 5n, end: 9n }], 1)
	h.emitted.length = 0
	message(h, commitMsg([[1n, 7n]])) // below end 9
	expect(outputs(h, 'reader.commit.resolved')).toHaveLength(0)
	let entry = h.ctx.partitions.get(pk(10n))!
	expect(entry.pendingCommits).toHaveLength(1)
	// server-confirmed coverage is compacted away so the claim list stays bounded
	expect(entry.claimedRanges).toEqual([{ start: 7n, end: 9n }])
})

test('emits partition.committed with the session on a commit ack', () => {
	let h = mk()
	toReadyWithPartition(h)
	commit(h, 10n, [{ start: 5n, end: 9n }], 1)
	h.emitted.length = 0
	message(h, commitMsg([[1n, 9n]]))
	let committed = outputs(h, 'reader.partition.committed')
	expect(committed).toHaveLength(1)
	expect(committed[0]).toMatchObject({ partitionId: 10n, committedOffset: 9n })
	expect(committed[0]!.session).toBe(h.ctx.partitions.get(pk(10n))!.session)
})

// ── reconnect reconcile (THE CRUX) ────────────────────────────────────────────────

test('re-sends an unacked commit on the new session after reconnect', () => {
	let h = mk()
	toReadyWithPartition(h) // session 1, committed 5
	commit(h, 10n, [{ start: 5n, end: 9n }], 1)
	// reconnect
	step(h, {
		type: 'reader.stream.disconnected',
		error: new YDBError(StatusIds_StatusCode.UNAVAILABLE, []),
	})
	step(h, { type: 'reader.timer.retry_backoff' })
	step(h, { type: 'reader.stream.init_response', sessionId: 's2' })
	h.emitted.length = 0
	// server re-sends Start for the same partition, still committed at 5 (commit lost)
	message(h, startMsg(2n, 10n, 5n))
	// nothing may hit the wire before the async start handshake completes
	expect(commitSends(h.effects)).toHaveLength(0)
	// the handshake completes — the ack carries the start response FIRST, then the
	// pending [5,9) re-send on the NEW session id (2)
	ackStart(h, 2n, 10n)
	let types = h.effects.map((e) => e.type)
	expect(types.indexOf('reader.effect.send.start_response')).toBeGreaterThanOrEqual(0)
	expect(types.indexOf('reader.effect.send.commit')).toBeGreaterThan(
		types.indexOf('reader.effect.send.start_response')
	)
	let cs = commitSends(h.effects)
	expect(cs).toHaveLength(1)
	expect(cs[0]!.partitionSessionId).toBe(2n)
	expect(cs[0]!.ranges).toEqual([{ start: 5n, end: 9n }])
	expect(h.ctx.partitions.get(pk(10n))!.pendingCommits).toHaveLength(1)
	expect(outputs(h, 'reader.commit.resolved')).toHaveLength(0)
})

test('replays each pending commit with its exact remaining ranges on resend', () => {
	let h = mk()
	toReadyWithPartition(h)
	ackStart(h, 1n, 10n)
	commit(h, 10n, [{ start: 5n, end: 6n }], 1)
	commit(h, 10n, [{ start: 8n, end: 9n }], 2)
	step(h, {
		type: 'reader.stream.disconnected',
		error: new YDBError(StatusIds_StatusCode.UNAVAILABLE, []),
	})
	step(h, { type: 'reader.timer.retry_backoff' })
	step(h, { type: 'reader.stream.init_response', sessionId: 's2' })
	message(h, startMsg(2n, 10n, 5n))
	ackStart(h, 2n, 10n)
	// One send per pending, ranges verbatim — a gap-covering [5,9) span would commit
	// the delivered-but-unacked offsets 6 and 7 behind the app's back.
	let cs = commitSends(h.effects)
	expect(cs.map((e) => e.ranges)).toEqual([[{ start: 5n, end: 6n }], [{ start: 8n, end: 9n }]])
})

test('sends a commit under the new session id after a within-stream regrant', () => {
	let h = mk()
	toReadyWithPartition(h)
	ackStart(h, 1n, 10n)
	// The same stream regrants the same partition under a new ephemeral id; its start
	// handshake completes before the commit.
	message(h, startMsg(2n, 10n, 5n))
	ackStart(h, 2n, 10n)
	commit(h, 10n, [{ start: 5n, end: 6n }], 1)
	let cs = commitSends(h.effects)
	expect(cs).toHaveLength(1)
	expect(cs[0]!.partitionSessionId).toBe(2n)
})

test('buffers a commit in the init-to-regrant window and re-sends it clamped on the new session', () => {
	let h = mk()
	toReadyWithPartition(h)
	ackStart(h, 1n, 10n)
	step(h, {
		type: 'reader.stream.disconnected',
		error: new YDBError(StatusIds_StatusCode.UNAVAILABLE, []),
	})
	step(h, { type: 'reader.timer.retry_backoff' })
	step(h, { type: 'reader.stream.init_response', sessionId: 's2' })
	// Window: ready on the new stream, partition not yet re-granted — session id 1
	// belongs to the dead stream, nothing may be sent under it.
	commit(h, 10n, [{ start: 5n, end: 7n }], 1)
	expect(commitSends(h.effects)).toHaveLength(0)
	// Re-granted with committed=6: the pending [5,7) narrows to [6,7) and is re-sent
	// once the start handshake completes.
	message(h, startMsg(7n, 10n, 6n))
	ackStart(h, 7n, 10n)
	let cs = commitSends(h.effects)
	expect(cs).toHaveLength(1)
	expect(cs[0]!.partitionSessionId).toBe(7n)
	expect(cs[0]!.ranges).toEqual([{ start: 6n, end: 7n }])
})

test('blocks a commit when the reused session id belongs to another partition', () => {
	let h = mk()
	toReadyWithPartition(h)
	ackStart(h, 1n, 10n)
	step(h, {
		type: 'reader.stream.disconnected',
		error: new YDBError(StatusIds_StatusCode.UNAVAILABLE, []),
	})
	step(h, { type: 'reader.timer.retry_backoff' })
	step(h, { type: 'reader.stream.init_response', sessionId: 's2' })
	// The new stream reuses numeric id 1 for a DIFFERENT partition (server assign ids
	// restart at 1 per stream).
	message(h, startMsg(1n, 20n, 0n))
	commit(h, 10n, [{ start: 5n, end: 6n }], 1)
	// Partition 10's entry still holds sessionId 1, but that id now belongs to
	// partition 20 — must buffer, never send under the colliding id.
	expect(commitSends(h.effects)).toHaveLength(0)
	expect(h.ctx.partitions.get(pk(10n))!.pendingCommits).toHaveLength(1)
})

test('resolves a pending commit that the server committed before the reconnect', () => {
	let h = mk()
	toReadyWithPartition(h)
	commit(h, 10n, [{ start: 5n, end: 9n }], 1)
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
	expect(h.ctx.partitions.get(pk(10n))!.pendingCommits).toHaveLength(0)
})

test('never rejects a pending commit merely because the stream reconnected', () => {
	let h = mk()
	toReadyWithPartition(h)
	commit(h, 10n, [{ start: 5n, end: 9n }], 1)
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
	commit(h, 10n, [{ start: 5n, end: 9n }], 1)
	h.emitted.length = 0
	message(h, stopMsg(1n, false))
	expect(h.ctx.partitions.get(pk(10n))!.state).toBe('stopped')
	expect(h.ctx.partitions.get(pk(10n))!.pendingCommits).toHaveLength(1) // held, not rejected
	expect(outputs(h, 'reader.commit.rejected')).toHaveLength(0)
	expect(h.effects).toContainEqual({
		type: 'reader.effect.timer.schedule',
		which: 'partition_reassign_gc',
		partitionKey: pk(10n),
	})
})

test('enters stopping-graceful and runs the stop hook even with no pending commits', () => {
	let h = mk()
	toReadyWithPartition(h)
	let grantId = h.ctx.partitions.get(pk(10n))!.grantId
	h.emitted.length = 0
	message(h, stopMsg(1n, true))
	// The stop response waits for the async onPartitionSessionStop hook even when
	// nothing is pending — the hook is the documented last chance to commit.
	expect(h.ctx.partitions.get(pk(10n))!.state).toBe('stopping-graceful')
	expect(stopResponses(h.effects)).toHaveLength(0)
	expect(outputs(h, 'reader.partition.stopped')).toHaveLength(0)
	expect(h.effects).toContainEqual({
		type: 'reader.effect.partition.stop_hook',
		partitionSessionId: 1n,
		partitionKey: pk(10n),
		grantId,
		committedOffset: 5n,
	})
	expect(h.effects).toContainEqual({
		type: 'reader.effect.timer.schedule',
		which: 'partition_graceful_timeout',
		partitionKey: pk(10n),
	})
})

test('sends the stop response once the stop hook completes and nothing is pending', () => {
	let h = mk()
	toReadyWithPartition(h)
	message(h, stopMsg(1n, true))
	h.emitted.length = 0
	ackStop(h, 10n)
	let sr = stopResponses(h.effects)
	expect(sr).toHaveLength(1)
	expect(sr[0]!.partitionSessionId).toBe(1n)
	expect(h.effects).toContainEqual({
		type: 'reader.effect.timer.clear',
		which: 'partition_graceful_timeout',
		partitionKey: pk(10n),
	})
	expect(h.ctx.partitions.get(pk(10n))!.state).toBe('stopped')
	let stopped = outputs(h, 'reader.partition.stopped')
	expect(stopped[0]).toMatchObject({ partitionId: 10n, reason: 'graceful' })
	expect(stopped[0]!.session.isStopped).toBe(true)
})

test('rejects held commits when a stopped partition is gc-reassigned', () => {
	let h = mk()
	toReadyWithPartition(h)
	commit(h, 10n, [{ start: 5n, end: 9n }], 1)
	message(h, stopMsg(1n, false))
	h.emitted.length = 0
	step(h, { type: 'reader.timer.partition_reassign_gc', partitionKey: pk(10n) })
	expect(outputs(h, 'reader.commit.rejected')[0]).toMatchObject({ waiterId: 1 })
	expect(h.ctx.partitions.has(pk(10n))).toBe(false)
})

// The facade dispatches commit() while the session is still live, but a stop request
// (or the commit_response completing a graceful drain) queued ahead of it can retire
// the partition first. Uncovered offsets of a stopped partition can never be acked on
// this stream, and the messages are redelivered wherever the partition lands — the
// waiter settles immediately instead of parking on the reassign gc.
test('rejects a commit that lost the race with the partition stop', () => {
	let h = mk()
	toReadyWithPartition(h)
	ackStart(h, 1n, 10n)
	message(h, stopMsg(1n, true))
	ackStop(h, 10n)
	expect(h.ctx.partitions.get(pk(10n))!.state).toBe('stopped')
	h.emitted.length = 0
	commit(h, 10n, [{ start: 5n, end: 9n }], 7)
	let rejected = outputs(h, 'reader.commit.rejected')
	expect(rejected).toHaveLength(1)
	expect(rejected[0]).toMatchObject({ waiterId: 7 })
	expect(String((rejected[0] as { reason?: unknown }).reason)).toMatch(
		/stopped or expired partition session/
	)
	expect(h.ctx.partitions.get(pk(10n))!.pendingCommits).toEqual([])
})

// The same race against a forced stop: offsets the stop's watermark already covers
// resolve, anything uncovered rejects — nothing is parked for the gc.
test('settles a commit racing a forced stop against the stop watermark', () => {
	let h = mk()
	toReadyWithPartition(h)
	ackStart(h, 1n, 10n)
	message(h, stopMsg(1n, false, 7n))
	expect(h.ctx.partitions.get(pk(10n))!.state).toBe('stopped')
	h.emitted.length = 0
	commit(h, 10n, [{ start: 5n, end: 7n }], 8)
	expect(outputs(h, 'reader.commit.resolved').map((o) => o.waiterId)).toEqual([8])
	commit(h, 10n, [{ start: 7n, end: 9n }], 9)
	expect(outputs(h, 'reader.commit.rejected')[0]).toMatchObject({ waiterId: 9 })
})

test('resolves covered commits and holds the remainder on a forced stop', () => {
	let h = mk()
	toReadyWithPartition(h)
	ackStart(h, 1n, 10n)
	commit(h, 10n, [{ start: 5n, end: 6n }], 1)
	commit(h, 10n, [{ start: 6n, end: 9n }], 2)
	// The stop reports committedOffset 6: waiter 1 succeeded server-side (resolve, do
	// not hang it for the gc window), waiter 2 is held for a possible reconcile,
	// bounded by the reassign gc.
	message(h, stopMsg(1n, false, 6n))
	expect(outputs(h, 'reader.commit.resolved').map((o) => o.waiterId)).toEqual([1])
	let entry = h.ctx.partitions.get(pk(10n))!
	expect(entry.state).toBe('stopped')
	expect(entry.pendingCommits.map((p) => p.waiterId)).toEqual([2])
	expect(h.effects).toContainEqual({
		type: 'reader.effect.timer.schedule',
		which: 'partition_reassign_gc',
		partitionKey: pk(10n),
	})
	// a graceful stop escalated to force leaves no fallback timer behind
	expect(h.effects).toContainEqual({
		type: 'reader.effect.timer.clear',
		which: 'partition_graceful_timeout',
		partitionKey: pk(10n),
	})
})

test('resolves commits covered by the graceful stop watermark while awaiting the stop hook', () => {
	let h = mk()
	toReadyWithPartition(h)
	ackStart(h, 1n, 10n)
	commit(h, 10n, [{ start: 5n, end: 7n }], 5)
	h.emitted.length = 0
	// The server already holds offset 7 — the stop must not wait on the pending
	// commit; only the stop hook remains between here and the stop response.
	message(h, stopMsg(1n, true, 7n))
	expect(outputs(h, 'reader.commit.resolved').map((o) => o.waiterId)).toEqual([5])
	expect(stopResponses(h.effects)).toHaveLength(0)
	expect(h.ctx.partitions.get(pk(10n))!.state).toBe('stopping-graceful')
	ackStop(h, 10n)
	expect(stopResponses(h.effects)).toHaveLength(1)
	expect(h.ctx.partitions.get(pk(10n))!.state).toBe('stopped')
})

test('updates the session committed offset from the stop request', () => {
	let h = mk()
	toReadyWithPartition(h)
	let session = h.ctx.partitions.get(pk(10n))!.session
	message(h, stopMsg(1n, true, 42n))
	// The facade's onPartitionSessionStop hook reads this value — it must be fresh.
	expect(session.partitionCommittedOffset).toBe(42n)
})

test('emits partition.committed when a stop request advances the watermark', () => {
	let h = mk()
	toReadyWithPartition(h)
	h.emitted.length = 0
	message(h, stopMsg(1n, true, 9n))
	let committed = outputs(h, 'reader.partition.committed')
	expect(committed).toHaveLength(1)
	expect(committed[0]).toMatchObject({ partitionId: 10n, committedOffset: 9n })
})

test('sends a commit for an ended partition session', () => {
	let h = mk()
	toReadyWithPartition(h)
	ackStart(h, 1n, 10n)
	// end_partition only marks the session ended — reading the final batch and then
	// committing it after the end frame is the normal flow, so the commit must still
	// hit the wire.
	message(h, endMsg(1n))
	expect(h.ctx.partitions.get(pk(10n))!.state).toBe('ended')
	commit(h, 10n, [{ start: 5n, end: 6n }], 1)
	expect(commitSends(h.effects)).toHaveLength(1)
})

test('delivers read responses while a partition is stopping gracefully', () => {
	let h = mk()
	toReadyWithPartition(h)
	message(h, stopMsg(1n, true))
	h.emitted.length = 0
	// The soft-stop contract is "finish processing and commit": in-flight responses
	// still belong to the app until the stop response goes out.
	message(h, readMsg(1n, 100n, [5n]))
	let delivered = outputs(h, 'reader.messages')
	expect(delivered[0]!.groups).toHaveLength(1)
	expect(delivered[0]!.groups[0]!.messages.map((m) => m.offset)).toEqual([5n])
})

// ── graceful stop drain & timers ────────────────────────────────────────────────

test('sends exactly one stop_response when the commit drain wins the graceful race', () => {
	let h = mk()
	toReadyWithPartition(h)
	ackStart(h, 1n, 10n)
	commit(h, 10n, [{ start: 5n, end: 6n }], 1)
	message(h, stopMsg(1n, true))
	expect(h.ctx.partitions.get(pk(10n))!.state).toBe('stopping-graceful')
	// Committing during a graceful stop is THE intended flow: the server waits
	// precisely so the consumer can finish committing delivered messages.
	commit(h, 10n, [{ start: 6n, end: 7n }], 2)
	expect(commitSends(h.effects)).toHaveLength(1)
	// The stop hook completes first; the response still waits for the commit drain.
	ackStop(h, 10n)
	expect(stopResponses(h.effects)).toHaveLength(0)
	// The ack drains everything: both waiters resolve, one stop_response goes out,
	// and the per-partition graceful timer is cleared.
	h.emitted.length = 0
	message(h, commitMsg([[1n, 7n]]))
	expect(outputs(h, 'reader.commit.resolved').map((o) => o.waiterId)).toEqual([1, 2])
	let sr = stopResponses(h.effects)
	expect(sr).toHaveLength(1)
	expect(sr[0]!.partitionSessionId).toBe(1n)
	expect(h.effects).toContainEqual({
		type: 'reader.effect.timer.clear',
		which: 'partition_graceful_timeout',
		partitionKey: pk(10n),
	})
	// A late (already-enqueued) per-partition timer firing after the drain: no-op.
	step(h, { type: 'reader.timer.partition_graceful_timeout', partitionKey: pk(10n) })
	expect(stopResponses(h.effects)).toHaveLength(0)
	expect(stopResponses(h.allEffects)).toHaveLength(1)
})

test('sends exactly one stop_response when the graceful timer wins the race', () => {
	let h = mk()
	toReadyWithPartition(h)
	ackStart(h, 1n, 10n)
	commit(h, 10n, [{ start: 5n, end: 6n }], 1)
	message(h, stopMsg(1n, true))
	step(h, { type: 'reader.timer.partition_graceful_timeout', partitionKey: pk(10n) })
	expect(stopResponses(h.effects)).toHaveLength(1)
	expect(h.ctx.partitions.get(pk(10n))!.state).toBe('stopped')
	// A late ack for the released session is dropped: no second stop_response.
	message(h, commitMsg([[1n, 6n]]))
	expect(stopResponses(h.effects)).toHaveLength(0)
	expect(stopResponses(h.allEffects)).toHaveLength(1)
})

test('drops a late stop_ready after a force stop escalates the graceful stop', () => {
	let h = mk()
	toReadyWithPartition(h)
	let grantId = h.ctx.partitions.get(pk(10n))!.grantId
	message(h, stopMsg(1n, true))
	h.emitted.length = 0
	message(h, stopMsg(1n, false))
	expect(outputs(h, 'reader.partition.stopped')[0]).toMatchObject({ reason: 'lost' })
	expect(h.effects).toContainEqual({
		type: 'reader.effect.timer.clear',
		which: 'partition_graceful_timeout',
		partitionKey: pk(10n),
	})
	// The stop hook completes after the escalation already gave the partition up: a
	// stop_response for the released session is session-fatal.
	step(h, { type: 'reader.partition.stop_ready', partitionKey: pk(10n), grantId })
	expect(h.effects).toEqual([])
	expect(stopResponses(h.allEffects)).toHaveLength(0)
})

test('ignores a stop_ready carrying a superseded grant id', () => {
	let h = mk()
	toReadyWithPartition(h)
	let staleGrant = h.ctx.partitions.get(pk(10n))!.grantId
	message(h, stopMsg(1n, true)) // stop hook for the first grant starts running
	step(h, {
		type: 'reader.stream.disconnected',
		error: new YDBError(StatusIds_StatusCode.UNAVAILABLE, []),
	})
	step(h, { type: 'reader.timer.retry_backoff' })
	step(h, { type: 'reader.stream.init_response', sessionId: 's2' })
	message(h, startMsg(2n, 10n, 5n)) // fresh grant supersedes the stopping one
	// The old grant's stop hook completes: it must not stop the fresh grant.
	step(h, { type: 'reader.partition.stop_ready', partitionKey: pk(10n), grantId: staleGrant })
	expect(h.ctx.partitions.get(pk(10n))!.state).toBe('active')
	expect(stopResponses(h.allEffects)).toHaveLength(0)
})

test('sends the stop response when the graceful timeout fires on the live session', () => {
	let h = mk()
	toReadyWithPartition(h)
	ackStart(h, 1n, 10n)
	commit(h, 10n, [{ start: 5n, end: 6n }], 1)
	message(h, stopMsg(1n, true))
	// The fallback fires with the session still current: give up waiting, answer the
	// server (it has no timeout of its own — the rebalance would stall forever), and
	// bound the held commit with the reassign gc.
	step(h, { type: 'reader.timer.partition_graceful_timeout', partitionKey: pk(10n) })
	expect(stopResponses(h.effects).map((s) => s.partitionSessionId)).toEqual([1n])
	expect(h.effects).toContainEqual({
		type: 'reader.effect.timer.schedule',
		which: 'partition_reassign_gc',
		partitionKey: pk(10n),
	})
	expect(h.ctx.partitions.get(pk(10n))?.state).toBe('stopped')
})

test('force-stops only the timed-out partition when two graceful stops are pending', () => {
	let h = mk()
	step(h, { type: 'reader.start' })
	step(h, { type: 'reader.stream.init_response', sessionId: 's1' })
	message(h, startMsg(1n, 7n, 0n))
	message(h, startMsg(2n, 9n, 0n))
	commit(h, 7n, [{ start: 0n, end: 1n }], 1)
	commit(h, 9n, [{ start: 0n, end: 1n }], 2)
	// Each graceful stop arms its own per-partition timer (a shared timer would let
	// concurrent graceful stops clobber one another).
	message(h, stopMsg(1n, true))
	expect(h.effects).toContainEqual({
		type: 'reader.effect.timer.schedule',
		which: 'partition_graceful_timeout',
		partitionKey: pk(7n),
	})
	message(h, stopMsg(2n, true))
	expect(h.effects).toContainEqual({
		type: 'reader.effect.timer.schedule',
		which: 'partition_graceful_timeout',
		partitionKey: pk(9n),
	})
	// Partition 7's fallback fires: only partition 7 is stopped and acknowledged.
	step(h, { type: 'reader.timer.partition_graceful_timeout', partitionKey: pk(7n) })
	expect(stopResponses(h.effects).map((s) => s.partitionSessionId)).toEqual([1n])
	expect(h.ctx.partitions.get(pk(7n))?.state).toBe('stopped')
	expect(h.ctx.partitions.get(pk(9n))?.state).toBe('stopping-graceful')
	// Partition 9's own fire later stops it.
	step(h, { type: 'reader.timer.partition_graceful_timeout', partitionKey: pk(9n) })
	expect(stopResponses(h.effects).map((s) => s.partitionSessionId)).toEqual([2n])
})

test('ignores a stray global graceful timeout in ready', () => {
	let h = mk()
	toReadyWithPartition(h)
	ackStart(h, 1n, 10n)
	commit(h, 10n, [{ start: 5n, end: 6n }], 1)
	message(h, stopMsg(1n, true))
	// The global timer is armed only by toClosing (the close() drain deadline); a
	// stray fire in ready must not tear the reader down or force-stop anything —
	// per-partition stalls are owned by partition_graceful_timeout.
	step(h, { type: 'reader.timer.graceful_timeout' })
	expect(h.state).toBe('ready')
	expect(h.ctx.partitions.get(pk(10n))?.state).toBe('stopping-graceful')
})

test('reconciles remaining commits on a regrant after a stalled graceful stop was forced', () => {
	let h = mk()
	toReadyWithPartition(h)
	ackStart(h, 1n, 10n)
	commit(h, 10n, [{ start: 5n, end: 7n }], 1)
	message(h, stopMsg(1n, true))
	step(h, { type: 'reader.timer.partition_graceful_timeout', partitionKey: pk(10n) })
	expect(h.ctx.partitions.get(pk(10n))!.state).toBe('stopped')
	// The partition comes back: the stale graceful timer is cleared on the grant…
	message(h, startMsg(9n, 10n, 6n))
	expect(h.effects).toContainEqual({
		type: 'reader.effect.timer.clear',
		which: 'partition_graceful_timeout',
		partitionKey: pk(10n),
	})
	// …and the held commit is re-sent narrowed once the start handshake completes.
	ackStart(h, 9n, 10n)
	let cs = commitSends(h.effects)
	expect(cs).toHaveLength(1)
	expect(cs[0]!.partitionSessionId).toBe(9n)
	expect(cs[0]!.ranges).toEqual([{ start: 6n, end: 7n }])
})

test('suppresses the stale stop_response when a reconnect reuses the session id', () => {
	let h = mk()
	toReadyWithPartition(h)
	ackStart(h, 1n, 10n)
	commit(h, 10n, [{ start: 5n, end: 6n }], 1)
	message(h, stopMsg(1n, true)) // partition 10 stopping-graceful, timer armed
	step(h, {
		type: 'reader.stream.disconnected',
		error: new YDBError(StatusIds_StatusCode.UNAVAILABLE, []),
	})
	step(h, { type: 'reader.timer.retry_backoff' })
	step(h, { type: 'reader.stream.init_response', sessionId: 's2' })
	// The new stream reuses assign id 1 for a DIFFERENT partition; partition 10 was
	// granted elsewhere. The stale per-partition timer from the old stream fires: a
	// stop_response under id 1 would release partition 20's LIVE session, which the
	// server answers with a session-fatal BAD_REQUEST.
	message(h, startMsg(1n, 20n, 0n))
	step(h, { type: 'reader.timer.partition_graceful_timeout', partitionKey: pk(10n) })
	expect(stopResponses(h.effects)).toHaveLength(0)
	// And partition 20's routing must survive the force-stop bookkeeping.
	expect(h.ctx.sessionIndex.get(1n)).toBe(pk(20n))
})

test('does not emit a stop_response onto a fresh connecting stream', () => {
	let h = mk()
	toReadyWithPartition(h)
	ackStart(h, 1n, 10n)
	commit(h, 10n, [{ start: 5n, end: 6n }], 1)
	message(h, stopMsg(1n, true))
	step(h, {
		type: 'reader.stream.disconnected',
		error: new YDBError(StatusIds_StatusCode.UNAVAILABLE, []),
	})
	// retry_backoff fired: the reader is 'connecting' and the transport already has a
	// live input queue — a send here would carry the OLD stream's session id onto the
	// new stream ahead of most traffic.
	step(h, { type: 'reader.timer.retry_backoff' })
	expect(h.state).toBe('connecting')
	step(h, { type: 'reader.timer.partition_graceful_timeout', partitionKey: pk(10n) })
	expect(stopResponses(h.effects)).toHaveLength(0)
})

test('ignores a late per-partition graceful timeout after the reader closed', () => {
	let h = mk()
	toReadyWithPartition(h)
	ackStart(h, 1n, 10n)
	commit(h, 10n, [{ start: 5n, end: 6n }], 1)
	message(h, stopMsg(1n, true))
	step(h, { type: 'reader.destroy', reason: new Error('bye') })
	expect(h.state).toBe('closed')
	step(h, { type: 'reader.timer.partition_graceful_timeout', partitionKey: pk(10n) })
	expect(h.state).toBe('closed')
	expect(h.effects).toEqual([])
})

// ── flow-control ────────────────────────────────────────────────────────────────

test('replenishes exactly the released read credit without delay', () => {
	let h = mk(1000n)
	toReadyWithPartition(h)
	message(h, readMsg(1n, 300n, [5n]))
	h.effects = []
	step(h, { type: 'reader.read_release', bytes: 150n })
	let first = h.effects.find(
		(e): e is Extract<ReaderEffect, { type: 'reader.effect.send.read_request' }> =>
			e.type === 'reader.effect.send.read_request'
	)
	expect(first?.bytesSize).toBe(150n)
	expect(h.ctx.inFlightBytes).toBe(150n)
	h.effects = []
	step(h, { type: 'reader.read_release', bytes: 100n })
	let second = h.effects.find(
		(e): e is Extract<ReaderEffect, { type: 'reader.effect.send.read_request' }> =>
			e.type === 'reader.effect.send.read_request'
	)
	expect(second?.bytesSize).toBe(100n)
	expect(h.ctx.inFlightBytes).toBe(50n)
})

test('reserves reconnect credit for retained responses', () => {
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
	expect(h.ctx.inFlightBytes).toBe(400n)
	expect(h.ctx.readCreditBytes).toBe(600n)
	expect(h.effects).toContainEqual({ type: 'reader.effect.send.read_request', bytesSize: 600n })
	expect(h.ctx.sessionIndex.size).toBe(0)
	step(h, { type: 'reader.read_release', bytes: 400n })
	expect(h.ctx.inFlightBytes).toBe(0n)
	expect(h.ctx.readCreditBytes).toBe(1000n)
	expect(h.effects).toEqual([{ type: 'reader.effect.send.read_request', bytesSize: 400n }])
})

test('accounts retained-byte releases during reconnect backoff and init', () => {
	let h = mk(1000n)
	toReadyWithPartition(h)
	message(h, readMsg(1n, 600n, [5n]))
	step(h, { type: 'reader.stream.disconnected' })
	step(h, { type: 'reader.read_release', bytes: 200n })
	expect(h.ctx.inFlightBytes).toBe(400n)
	expect(h.effects).toEqual([])
	step(h, { type: 'reader.timer.retry_backoff' })
	step(h, { type: 'reader.read_release', bytes: 100n })
	expect(h.ctx.inFlightBytes).toBe(300n)
	expect(h.effects).toEqual([])
	step(h, { type: 'reader.stream.init_response', sessionId: 's2' })
	expect(h.ctx.readCreditBytes).toBe(700n)
	expect(h.effects).toContainEqual({ type: 'reader.effect.send.read_request', bytesSize: 700n })
})

test('repays current-stream overdraw without increasing the credit window', () => {
	let h = mk(1000n)
	toReadyWithPartition(h)
	message(h, readMsg(1n, 1400n, [5n]))
	expect(h.ctx.readCreditBytes).toBe(-400n)
	step(h, { type: 'reader.read_release', bytes: 1400n })
	expect(h.ctx.inFlightBytes).toBe(0n)
	expect(h.ctx.readCreditBytes).toBe(1000n)
	expect(h.effects).toEqual([{ type: 'reader.effect.send.read_request', bytesSize: 1400n }])
})

// (tx read-offset tracking lives in the facade — the FSM is tx-agnostic; covered
// by reader.contract.test.ts and the e2e tx tests.)

// ── start handshake (grant → start_ready) ─────────────────────────────────────────

test('drops a start_ready that lands after the partition was force-stopped', () => {
	let h = mk()
	toReadyWithPartition(h)
	message(h, stopMsg(1n, false))
	// The hook completes after the server already revoked the grant: no response, no
	// commit re-send.
	ackStart(h, 1n, 10n)
	expect(startResponses(h.effects)).toHaveLength(0)
	expect(commitSends(h.effects)).toHaveLength(0)
})

test('answers a grant exactly once when a stale start_ready from the previous stream collides', () => {
	let h = mk()
	step(h, { type: 'reader.start' })
	step(h, { type: 'reader.stream.init_response', sessionId: 's1' })
	message(h, startMsg(1n, 10n, 5n))
	let staleGrant = h.ctx.partitions.get(pk(10n))!.grantId // hook 1 still running
	step(h, {
		type: 'reader.stream.disconnected',
		error: new YDBError(StatusIds_StatusCode.UNAVAILABLE, []),
	})
	step(h, { type: 'reader.timer.retry_backoff' })
	step(h, { type: 'reader.stream.init_response', sessionId: 's2' })
	// The new stream grants the same partition under the SAME per-stream id 1 (server
	// assign ids restart at 1) — only the grantId epoch tells the two hooks apart.
	message(h, startMsg(1n, 10n, 5n))
	let before = h.allEffects.length
	// The stale hook (stream 1) completes, then the current one. A second
	// StartPartitionSessionResponse for one assign id is session-fatal
	// ("double partition locking", BAD_REQUEST).
	step(h, {
		type: 'reader.partition.start_ready',
		partitionSessionId: 1n,
		partitionKey: pk(10n),
		grantId: staleGrant,
	})
	ackStart(h, 1n, 10n)
	expect(startResponses(h.allEffects.slice(before))).toHaveLength(1)
})

test('passes readOffset and commitOffset overrides through to the start response', () => {
	let h = mk()
	toReadyWithPartition(h)
	step(h, {
		type: 'reader.partition.start_ready',
		partitionSessionId: 1n,
		partitionKey: pk(10n),
		grantId: h.ctx.partitions.get(pk(10n))!.grantId,
		readOffset: 12n,
		commitOffset: 10n,
	})
	let rs = startResponses(h.effects)
	expect(rs).toHaveLength(1)
	expect(rs[0]!.readOffset).toBe(12n)
	expect(rs[0]!.commitOffset).toBe(10n)
})

test('confirms a commitOffset override only from a server watermark', () => {
	let h = mk()
	toReadyWithPartition(h) // server says committed 5
	h.emitted.length = 0
	step(h, {
		type: 'reader.partition.start_ready',
		partitionSessionId: 1n,
		partitionKey: pk(10n),
		grantId: h.ctx.partitions.get(pk(10n))!.grantId,
		commitOffset: 10n,
	})
	expect(outputs(h, 'reader.partition.committed')).toHaveLength(0)
	expect(h.ctx.partitions.get(pk(10n))!.partitionCommittedOffset).toBe(5n)
	expect(h.effects).toContainEqual({
		type: 'reader.effect.send.partition_status',
		partitionSessionId: 1n,
	})
	step(h, {
		type: 'reader.stream.partition_status',
		partitionSessionId: 1n,
		committedOffset: 10n,
	})
	let committed = outputs(h, 'reader.partition.committed')
	expect(committed).toHaveLength(1)
	expect(committed[0]).toMatchObject({ partitionId: 10n, committedOffset: 10n })
})

test('clamps a subsequent commit at the commitOffset override', () => {
	let h = mk()
	toReadyWithPartition(h) // server says committed 5
	step(h, {
		type: 'reader.partition.start_ready',
		partitionSessionId: 1n,
		partitionKey: pk(10n),
		grantId: h.ctx.partitions.get(pk(10n))!.grantId,
		commitOffset: 10n,
	})
	commit(h, 10n, [{ start: 5n, end: 13n }], 1)
	let cs = commitSends(h.effects)
	expect(cs).toHaveLength(1)
	// The requested override suppresses overlapping wire ranges before its ack.
	expect(cs[0]!.ranges).toEqual([{ start: 10n, end: 13n }])
})

test('waits for confirmation of an override covering a pending commit', () => {
	let h = mk()
	toReadyWithPartition(h)
	ackStart(h, 1n, 10n)
	commit(h, 10n, [{ start: 5n, end: 8n }], 1)
	step(h, {
		type: 'reader.stream.disconnected',
		error: new YDBError(StatusIds_StatusCode.UNAVAILABLE, []),
	})
	step(h, { type: 'reader.timer.retry_backoff' })
	step(h, { type: 'reader.stream.init_response', sessionId: 's2' })
	message(h, startMsg(7n, 10n, 5n)) // the server still says committed 5
	// Re-sending [5,8) after the override would overlap the server's pending commit.
	step(h, {
		type: 'reader.partition.start_ready',
		partitionSessionId: 7n,
		partitionKey: pk(10n),
		grantId: h.ctx.partitions.get(pk(10n))!.grantId,
		commitOffset: 10n,
	})
	expect(commitSends(h.effects)).toHaveLength(0)
	expect(outputs(h, 'reader.commit.resolved')).toHaveLength(0)
	step(h, {
		type: 'reader.stream.partition_status',
		partitionSessionId: 7n,
		committedOffset: 10n,
	})
	expect(outputs(h, 'reader.commit.resolved').map((o) => o.waiterId)).toContain(1)
})

test('retries status confirmation and stops querying a revoked partition', () => {
	let h = mk()
	toReadyWithPartition(h)
	step(h, {
		type: 'reader.partition.start_ready',
		partitionSessionId: 1n,
		partitionKey: pk(10n),
		grantId: h.ctx.partitions.get(pk(10n))!.grantId,
		commitOffset: 10n,
	})
	step(h, { type: 'reader.stream.partition_status', partitionSessionId: 1n, committedOffset: 5n })
	expect(h.effects).toContainEqual({
		type: 'reader.effect.timer.schedule',
		which: 'partition_commit_status',
		partitionKey: pk(10n),
	})
	step(h, { type: 'reader.timer.partition_commit_status', partitionKey: pk(10n) })
	expect(h.effects).toEqual([
		{ type: 'reader.effect.send.partition_status', partitionSessionId: 1n },
	])
	message(h, stopMsg(1n, false, 5n))
	expect(h.effects).toContainEqual({
		type: 'reader.effect.timer.clear',
		which: 'partition_commit_status',
		partitionKey: pk(10n),
	})
	h.emitted.length = 0
	step(h, {
		type: 'reader.stream.partition_status',
		partitionSessionId: 1n,
		committedOffset: 10n,
	})
	expect(outputs(h, 'reader.partition.committed')).toHaveLength(0)
	step(h, { type: 'reader.timer.partition_commit_status', partitionKey: pk(10n) })
	expect(h.effects).toEqual([])
})

test('replays ranges suppressed by an unconfirmed override after reconnect', () => {
	let h = mk()
	toReadyWithPartition(h)
	step(h, {
		type: 'reader.partition.start_ready',
		partitionSessionId: 1n,
		partitionKey: pk(10n),
		grantId: h.ctx.partitions.get(pk(10n))!.grantId,
		commitOffset: 10n,
	})
	commit(h, 10n, [{ start: 5n, end: 8n }], 1)
	expect(commitSends(h.effects)).toHaveLength(0)
	step(h, { type: 'reader.stream.disconnected' })
	expect(h.effects).toContainEqual({
		type: 'reader.effect.timer.clear',
		which: 'partition_commit_status',
		partitionKey: pk(10n),
	})
	step(h, { type: 'reader.timer.retry_backoff' })
	step(h, { type: 'reader.stream.init_response', sessionId: 's2' })
	message(h, startMsg(7n, 10n, 5n))
	ackStart(h, 7n, 10n)
	expect(commitSends(h.effects)).toEqual([
		{
			type: 'reader.effect.send.commit',
			partitionSessionId: 7n,
			ranges: [{ start: 5n, end: 8n }],
		},
	])
	expect(outputs(h, 'reader.commit.resolved')).toHaveLength(0)
	message(h, commitMsg([[7n, 8n]]))
	expect(outputs(h, 'reader.commit.resolved').map((o) => o.waiterId)).toEqual([1])
})

test('drains an unconfirmed start override before closing', () => {
	let h = mk()
	toReadyWithPartition(h)
	step(h, {
		type: 'reader.partition.start_ready',
		partitionSessionId: 1n,
		partitionKey: pk(10n),
		grantId: h.ctx.partitions.get(pk(10n))!.grantId,
		commitOffset: 10n,
	})
	step(h, { type: 'reader.close' })
	expect(h.state).toBe('closing')
	step(h, {
		type: 'reader.stream.partition_status',
		partitionSessionId: 1n,
		committedOffset: 10n,
	})
	expect(h.state).toBe('closed')
	expect(outputs(h, 'reader.partition.committed')).toContainEqual(
		expect.objectContaining({ committedOffset: 10n })
	)
})

test('accepts a stop watermark as confirmation of the start override', () => {
	let h = mk()
	toReadyWithPartition(h)
	step(h, {
		type: 'reader.partition.start_ready',
		partitionSessionId: 1n,
		partitionKey: pk(10n),
		grantId: h.ctx.partitions.get(pk(10n))!.grantId,
		commitOffset: 10n,
	})
	message(h, stopMsg(1n, true, 10n))
	expect(h.effects).toContainEqual({
		type: 'reader.effect.timer.clear',
		which: 'partition_commit_status',
		partitionKey: pk(10n),
	})
	ackStop(h, 10n)
	expect(h.ctx.partitions.get(pk(10n))!.state).toBe('stopped')
	expect(h.effects).toContainEqual({
		type: 'reader.effect.send.stop_response',
		partitionSessionId: 1n,
	})
})

test('does not double-send a commit issued between start_partition and start_ready', () => {
	let h = mk()
	toReadyWithPartition(h)
	ackStart(h, 1n, 10n)
	commit(h, 10n, [{ start: 5n, end: 8n }], 1)
	step(h, {
		type: 'reader.stream.disconnected',
		error: new YDBError(StatusIds_StatusCode.UNAVAILABLE, []),
	})
	step(h, { type: 'reader.timer.retry_backoff' })
	step(h, { type: 'reader.stream.init_response', sessionId: 's2' })
	message(h, startMsg(7n, 10n, 5n))
	// A commit lands while the hook is still running: buffered — two identical ranges
	// on one stream would intersect the server's NextRanges (session-fatal).
	commit(h, 10n, [{ start: 8n, end: 10n }], 2)
	expect(commitSends(h.effects)).toHaveLength(0)
	// The ack performs the single send of everything buffered, after the response —
	// one send per pending with its own ranges.
	ackStart(h, 7n, 10n)
	let cs = commitSends(h.effects)
	expect(cs.map((e) => e.ranges)).toEqual([[{ start: 5n, end: 8n }], [{ start: 8n, end: 10n }]])
})

test('keeps the reassign gc armed from reconnect until the start_ready ack clears it', () => {
	let h = mk()
	toReadyWithPartition(h)
	ackStart(h, 1n, 10n)
	commit(h, 10n, [{ start: 5n, end: 6n }], 1)
	step(h, {
		type: 'reader.stream.disconnected',
		error: new YDBError(StatusIds_StatusCode.UNAVAILABLE, []),
	})
	step(h, { type: 'reader.timer.retry_backoff' })
	step(h, { type: 'reader.stream.init_response', sessionId: 's2' })
	// Entering ready armed a per-partition gc for the entry holding a pending commit:
	// the wait for a re-grant is bounded.
	expect(h.allEffects).toContainEqual({
		type: 'reader.effect.timer.schedule',
		which: 'partition_reassign_gc',
		partitionKey: pk(10n),
	})
	// start_partition must NOT clear it (the hook may hang)…
	message(h, startMsg(7n, 10n, 5n))
	expect(h.effects).not.toContainEqual({
		type: 'reader.effect.timer.clear',
		which: 'partition_reassign_gc',
		partitionKey: pk(10n),
	})
	// …only the ack does.
	ackStart(h, 7n, 10n)
	expect(h.effects).toContainEqual({
		type: 'reader.effect.timer.clear',
		which: 'partition_reassign_gc',
		partitionKey: pk(10n),
	})
})

test('bounds pending commits when the start hook never completes', () => {
	let h = mk()
	toReadyWithPartition(h)
	ackStart(h, 1n, 10n)
	commit(h, 10n, [{ start: 5n, end: 6n }], 1)
	step(h, {
		type: 'reader.stream.disconnected',
		error: new YDBError(StatusIds_StatusCode.UNAVAILABLE, []),
	})
	step(h, { type: 'reader.timer.retry_backoff' })
	step(h, { type: 'reader.stream.init_response', sessionId: 's2' })
	// Re-granted, but the onPartitionSessionStart hook hangs: start_ready never
	// arrives, so nothing else could ever settle the waiter — the gc bounds it.
	message(h, startMsg(1n, 10n, 5n))
	h.emitted.length = 0
	step(h, { type: 'reader.timer.partition_reassign_gc', partitionKey: pk(10n) })
	expect(outputs(h, 'reader.commit.rejected').map((o) => o.waiterId)).toEqual([1])
	// The granted entry survives so a late ack can still answer the server.
	expect(h.ctx.partitions.has(pk(10n))).toBe(true)
	expect(h.ctx.partitions.get(pk(10n))!.pendingCommits).toHaveLength(0)
	expect(h.ctx.partitions.get(pk(10n))!.claimedRanges).toHaveLength(0)
})

test('reaps a never-re-granted partition on gc and recreates it cleanly on a late grant', () => {
	let h = mk()
	toReadyWithPartition(h)
	ackStart(h, 1n, 10n)
	commit(h, 10n, [{ start: 5n, end: 6n }], 1)
	step(h, {
		type: 'reader.stream.disconnected',
		error: new YDBError(StatusIds_StatusCode.UNAVAILABLE, []),
	})
	step(h, { type: 'reader.timer.retry_backoff' })
	step(h, { type: 'reader.stream.init_response', sessionId: 's2' })
	// Never re-granted on this stream (rebalanced away during the outage): the gc
	// rejects the orphaned waiter instead of holding it until close().
	step(h, { type: 'reader.timer.partition_reassign_gc', partitionKey: pk(10n) })
	expect(outputs(h, 'reader.commit.rejected').map((o) => o.waiterId)).toEqual([1])
	expect(h.ctx.partitions.has(pk(10n))).toBe(false)
	// A LATE grant after the reap creates a fresh entry.
	message(h, startMsg(9n, 10n, 20n))
	let entry = h.ctx.partitions.get(pk(10n))!
	expect(entry.partitionSessionId).toBe(9n)
	expect(entry.state).toBe('active')
	expect(entry.deliveredWatermark).toBe(20n)
	expect(entry.pendingCommits).toHaveLength(0)
	ackStart(h, 9n, 10n)
	expect(startResponses(h.effects)).toHaveLength(1)
})

test('answers a start_ready during the closing drain', () => {
	let h = mk()
	toReadyWithPartition(h)
	ackStart(h, 1n, 10n)
	commit(h, 10n, [{ start: 5n, end: 6n }], 1)
	step(h, { type: 'reader.close' })
	expect(h.state).toBe('closing')
	// A grant that raced the close is still acked so its commits can drain.
	message(h, startMsg(2n, 10n, 5n))
	ackStart(h, 2n, 10n)
	expect(startResponses(h.effects)).toHaveLength(1)
})

// ── terminal ──────────────────────────────────────────────────────────────────

test('rejects outstanding commits exactly once on destroy and terminates', () => {
	let h = mk()
	toReadyWithPartition(h)
	commit(h, 10n, [{ start: 5n, end: 9n }], 1)
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
	commit(h, 10n, [{ start: 5n, end: 9n }], 1)
	step(h, { type: 'reader.close' })
	expect(h.state).toBe('closing')
	// draining the commit lets it finish
	message(h, commitMsg([[1n, 9n]]))
	expect(h.state).toBe('closed')
})

test('waits for a graceful stop drain before closing', () => {
	let h = mk()
	toReadyWithPartition(h)
	ackStart(h, 1n, 10n)
	message(h, stopMsg(1n, true))
	// A stopping-graceful partition counts as pending work even with zero pending
	// commits: its stop hook is still owed an answer.
	step(h, { type: 'reader.close' })
	expect(h.state).toBe('closing')
	h.emitted.length = 0
	ackStop(h, 10n)
	expect(h.state).toBe('closed')
	expect(outputs(h, 'reader.partition.stopped')[0]).toMatchObject({ reason: 'graceful' })
	expect(outputs(h, 'reader.closed')).toHaveLength(1)
})

test('keeps draining in closing when one partition force-stops on its timer', () => {
	let h = mk()
	toReadyWithPartition(h)
	ackStart(h, 1n, 10n)
	message(h, startMsg(2n, 20n, 0n))
	commit(h, 10n, [{ start: 5n, end: 6n }], 1)
	commit(h, 20n, [{ start: 0n, end: 1n }], 2)
	message(h, stopMsg(1n, true))
	step(h, { type: 'reader.close' })
	expect(h.state).toBe('closing')
	// The per-partition fallback fires: partition 10 force-stops, the reader stays
	// closing (partition 20's commit is still pending).
	step(h, { type: 'reader.timer.partition_graceful_timeout', partitionKey: pk(10n) })
	expect(h.state).toBe('closing')
	expect(stopResponses(h.effects)).toHaveLength(1)
	// The global close deadline finalizes and rejects the leftovers.
	step(h, { type: 'reader.timer.graceful_timeout' })
	expect(h.state).toBe('closed')
	expect(outputs(h, 'reader.commit.rejected').length).toBeGreaterThan(0)
	expect(outputs(h, 'reader.closed')).toHaveLength(1)
})

test('finalizes from closing when the reassign gc drains the last held commit', () => {
	let h = mk()
	toReadyWithPartition(h)
	ackStart(h, 1n, 10n)
	commit(h, 10n, [{ start: 5n, end: 6n }], 1)
	message(h, stopMsg(1n, true))
	step(h, { type: 'reader.close' })
	expect(h.state).toBe('closing')
	// The per-partition fallback force-stops the partition; its commit is still held
	// (reconcile window), so the reader keeps draining — bounded by the reassign gc,
	// never hanging in a state with no armed timer.
	step(h, { type: 'reader.timer.partition_graceful_timeout', partitionKey: pk(10n) })
	expect(h.state).toBe('closing')
	expect(h.effects).toContainEqual({
		type: 'reader.effect.timer.schedule',
		which: 'partition_reassign_gc',
		partitionKey: pk(10n),
	})
	step(h, { type: 'reader.timer.partition_reassign_gc', partitionKey: pk(10n) })
	expect(h.state).toBe('closed')
})
