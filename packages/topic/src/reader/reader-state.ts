import type { Timestamp } from '@bufbuild/protobuf/wkt'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { YDBError } from '@ydbjs/error'
import type { TransitionResult, TransitionRuntime } from '@ydbjs/fsm'
import { isRetryableError, isRetryableStreamError } from '@ydbjs/retry'

import { TopicPartitionSession } from '../partition-session.js'

// The pure half of the reader: states, context, and a synchronous transition
// with no I/O. Mirrors writer-state.ts. The transport FSM owns one streamRead
// stream and forwards server frames; the runtime's mapTransportOutput CLASSIFIES
// them into the typed `reader.stream.*` events below, so this transition works on
// clean domain events — never raw protobuf.
//
// KEY DESIGN (see project decisions): all reader state is keyed by the STABLE
// partitionId, never the ephemeral partitionSessionId (proto: "unique inside one
// RPC call"). Pending commits are held across reconnect and reconciled per-partition
// on each start_partition, so commit() is never rejected by a transparent reconnect.
// Commit promises live in the facade keyed by waiterId — the transition holds no
// callbacks, which keeps it model-testable.

// ── State / context ─────────────────────────────────────────────────────────────

export type ReaderState =
	| 'idle'
	| 'connecting'
	| 'ready'
	| 'reconnecting'
	| 'closing'
	| 'closed'
	| 'errored'

// A commit awaiting the server's high-water-mark ack. `waiterId` maps to a Promise
// in the facade; the transition only records the offset range.
export type PendingCommit = {
	startOffset: bigint
	endOffset: bigint
	waiterId: number
}

// Everything the reader tracks about one partition, keyed by the stable partitionId.
// `sessionId` is the current ephemeral partition-session id (changes each reconnect).
export type PartitionEntry = {
	partitionId: bigint
	path: string
	sessionId: bigint
	session: TopicPartitionSession
	partitionOffsets: { start: bigint; end: bigint }
	partitionCommittedOffset: bigint
	// Gap-fill anchor: the start of the next commit range. Survives reconnect and is
	// never rewound below a start_partition committed_offset (see startPartitionSession).
	nextCommitStartOffset: bigint
	state: 'active' | 'stopping-graceful' | 'stopped' | 'ended'
	pendingCommits: PendingCommit[]
}

// One partition's slice of a ReadResponse — the structural shape the transition
// consumes (a subset of the protobuf PartitionData).
export type PartitionReadData = {
	partitionSessionId: bigint
	batches: {
		producerId: string
		codec: number
		writtenAt?: Timestamp
		messageData: {
			offset: bigint
			seqNo: bigint
			data: Uint8Array
			uncompressedSize: bigint
			createdAt?: Timestamp
			metadataItems: { key: string; value: Uint8Array }[]
		}[]
	}[]
}

// A message parsed out of a ReadResponse. The transition emits these; the runtime
// decompresses `data` via the codec map and builds the user-facing TopicMessage.
export type ReaderMessage = {
	offset: bigint
	seqNo: bigint
	data: Uint8Array
	uncompressedSize: bigint
	producer: string
	codec: number
	createdAt?: Timestamp
	writtenAt?: Timestamp
	metadataItems: { key: string; value: Uint8Array }[]
}

export type ReaderLimits = {
	maxBufferBytes: bigint
}

// Pure logical context — mutated synchronously inside the transition only.
export type ReaderCtx = {
	// reconnect bookkeeping (mirrors the writer)
	sessionId: string
	hasEverConnected: boolean
	attempts: number
	lastError: unknown
	retryScheduled: boolean
	startTimeoutScheduled: boolean
	// When set, a SCHEME_ERROR (e.g. the topic does not exist yet) is retried instead
	// of being fatal — the reader waits until the topic is created.
	retryOnSchemeError: boolean
	// Terminal reconnect deadline (ms). Infinity = unbounded (reconnect forever); the
	// transition owns whether to arm the `recovery_window` timer based on this.
	recoveryWindowMs: number

	// partition registry — keyed by STABLE partitionId
	partitions: Map<bigint, PartitionEntry>
	// ephemeral partitionSessionId -> partitionId, rebuilt each stream
	sessionIndex: Map<bigint, bigint>

	// byte flow-control
	limits: ReaderLimits
	inFlightBytes: bigint
	pendingReadRequestBytes: bigint
}

export type TimerName =
	| 'start_timeout'
	| 'retry_backoff'
	| 'recovery_window'
	| 'update_token'
	| 'graceful_timeout'
	| 'partition_reassign_gc'

// Typed server-stream events, classified from the protobuf in mapTransportOutput.
export type ReaderStreamEvent =
	| { type: 'reader.stream.read_response'; partitionData: PartitionReadData[]; bytesSize: bigint }
	| {
			type: 'reader.stream.start_partition'
			partitionSessionId: bigint
			partitionId: bigint
			path: string
			committedOffset: bigint
			partitionOffsets: { start: bigint; end: bigint }
	  }
	| {
			type: 'reader.stream.stop_partition'
			partitionSessionId: bigint
			graceful: boolean
			committedOffset: bigint
	  }
	| {
			type: 'reader.stream.commit_response'
			committed: { partitionSessionId: bigint; committedOffset: bigint }[]
	  }
	| { type: 'reader.stream.end_partition'; partitionSessionId: bigint }

export type ReaderEvent =
	// user (dispatched by the facade)
	| { type: 'reader.start' }
	| { type: 'reader.commit'; partitionId: bigint; offsets: bigint[]; waiterId: number }
	| { type: 'reader.read_release'; bytes: bigint }
	| { type: 'reader.close' }
	| { type: 'reader.destroy'; reason?: unknown }
	// transport -> reader
	| { type: 'reader.stream.init_response'; sessionId: string }
	| ReaderStreamEvent
	| { type: 'reader.stream.disconnected'; error?: unknown }
	// timers
	| { type: 'reader.timer.start_timeout' }
	| { type: 'reader.timer.retry_backoff' }
	| { type: 'reader.timer.recovery_window' }
	| { type: 'reader.timer.update_token' }
	| { type: 'reader.timer.graceful_timeout' }
	| { type: 'reader.timer.partition_reassign_gc'; partitionId: bigint }

export type ReaderEffect =
	| { type: 'reader.effect.transport.connect' }
	// Domain-level client messages; the runtime builds the protobuf wire frame (mirrors
	// the writer, whose transition emits MessageData and the runtime frames the request).
	| { type: 'reader.effect.send.read_request'; bytesSize: bigint }
	| {
			type: 'reader.effect.send.commit'
			partitionSessionId: bigint
			ranges: { start: bigint; end: bigint }[]
	  }
	| { type: 'reader.effect.send.stop_response'; partitionSessionId: bigint }
	| { type: 'reader.effect.transport.send_update_token' }
	| { type: 'reader.effect.transport.close' }
	// Runs the async onPartitionSessionStart callback then sends the response.
	| {
			type: 'reader.effect.partition.start_ack'
			partitionSessionId: bigint
			partitionId: bigint
			committedOffset: bigint
			partitionOffsets: { start: bigint; end: bigint }
	  }
	| { type: 'reader.effect.timer.schedule'; which: TimerName; partitionId?: bigint }
	| { type: 'reader.effect.timer.clear'; which: TimerName; partitionId?: bigint }
	| { type: 'reader.effect.finalize'; reason: unknown }

export type ReaderOutput =
	| { type: 'reader.session'; sessionId: string }
	// One output per ReadResponse. `releaseBytes` is the whole response size; the
	// facade dispatches reader.read_release with it once — a response spanning several
	// partitions releases its credit exactly once, not per partition.
	| {
			type: 'reader.messages'
			releaseBytes: bigint
			groups: { session: TopicPartitionSession; messages: ReaderMessage[] }[]
	  }
	| {
			type: 'reader.partition.started'
			partitionId: bigint
			partitionSessionId: bigint
			committedOffset: bigint
			session: TopicPartitionSession
	  }
	| {
			type: 'reader.partition.stopped'
			partitionId: bigint
			reason: 'graceful' | 'lost' | 'ended'
	  }
	| { type: 'reader.committed'; partitionId: bigint; committedOffset: bigint }
	| { type: 'reader.commit.resolved'; waiterId: number }
	| { type: 'reader.commit.rejected'; waiterId: number; reason: unknown }
	| { type: 'reader.reconnecting'; attempt: number; error?: unknown }
	| { type: 'reader.error'; error: unknown }
	| { type: 'reader.closed'; reason?: unknown }

type ReaderRuntime = TransitionRuntime<ReaderState, ReaderEvent, ReaderOutput>

// ── Helpers ─────────────────────────────────────────────────────────────────────

export let createReaderCtx = function createReaderCtx(
	limits: ReaderLimits,
	options?: { retryOnSchemeError?: boolean; recoveryWindowMs?: number }
): ReaderCtx {
	return {
		sessionId: '',
		hasEverConnected: false,
		attempts: 0,
		lastError: undefined,
		retryScheduled: false,
		startTimeoutScheduled: false,
		retryOnSchemeError: options?.retryOnSchemeError ?? false,
		recoveryWindowMs: options?.recoveryWindowMs ?? Infinity,

		partitions: new Map(),
		sessionIndex: new Map(),

		limits,
		inFlightBytes: 0n,
		pendingReadRequestBytes: 0n,
	}
}

// Reconnecting is always safe for a reader (offsets are server-tracked), so we
// retry any retryable stream error; a clean end (undefined) is a server-side
// reconnect. Fatal statuses (SCHEME_ERROR, UNAUTHORIZED, …) stop the reader —
// except SCHEME_ERROR is retried when `retryOnSchemeError` is set (wait for the
// topic to be created).
export let isRetryableReaderError = function isRetryableReaderError(
	error: unknown,
	retryOnSchemeError = false
): boolean {
	if (error === undefined || error === null) {
		return true
	}
	if (
		retryOnSchemeError &&
		error instanceof YDBError &&
		error.code === StatusIds_StatusCode.SCHEME_ERROR
	) {
		return true
	}
	return isRetryableStreamError(error) || isRetryableError(error, false)
}

let clearScheduling = function clearScheduling(ctx: ReaderCtx): void {
	ctx.retryScheduled = false
	ctx.startTimeoutScheduled = false
}

let clearConnectTimersEffects: ReaderEffect[] = [
	{ type: 'reader.effect.timer.clear', which: 'start_timeout' },
	{ type: 'reader.effect.timer.clear', which: 'retry_backoff' },
	{ type: 'reader.effect.timer.clear', which: 'recovery_window' },
]

let readRequestEffect = function readRequestEffect(bytesSize: bigint): ReaderEffect {
	return { type: 'reader.effect.send.read_request', bytesSize }
}

let commitEffect = function commitEffect(
	partitionSessionId: bigint,
	ranges: { start: bigint; end: bigint }[]
): ReaderEffect {
	return { type: 'reader.effect.send.commit', partitionSessionId, ranges }
}

let stopResponseEffect = function stopResponseEffect(partitionSessionId: bigint): ReaderEffect {
	return { type: 'reader.effect.send.stop_response', partitionSessionId }
}

// Group a partition's sorted offsets into disjoint [start, end) ranges, filling the
// gap between the last commit point (nextCommitStartOffset — covers retention-deleted
// offsets) and the first message. Advances nextCommitStartOffset. Mirrors _commit.ts.
let buildCommitRanges = function buildCommitRanges(
	entry: PartitionEntry,
	offsets: bigint[]
): { start: bigint; end: bigint }[] {
	let ranges: { start: bigint; end: bigint }[] = []
	for (let offset of offsets) {
		let last = ranges[ranges.length - 1]
		if (last === undefined) {
			// First range starts at the gap-fill anchor so retention gaps are covered.
			ranges.push({ start: entry.nextCommitStartOffset, end: offset + 1n })
		} else if (offset + 1n <= last.end) {
			// Duplicate / already covered — skip (facade validates order, defensive here).
			continue
		} else if (offset === last.end) {
			last.end = offset + 1n
		} else {
			ranges.push({ start: offset, end: offset + 1n })
		}
	}
	let lastRange = ranges[ranges.length - 1]
	if (lastRange !== undefined) {
		entry.nextCommitStartOffset = lastRange.end
	}
	return ranges
}

// Resolve pending commits already covered by a committed high-water mark; return the
// waiterIds to resolve. Used by both the commit-ack path and the reconnect reconcile.
let drainCommits = function drainCommits(entry: PartitionEntry, committedOffset: bigint): number[] {
	let resolved: number[] = []
	let kept: PendingCommit[] = []
	for (let pending of entry.pendingCommits) {
		if (pending.endOffset <= committedOffset) {
			resolved.push(pending.waiterId)
		} else {
			kept.push(pending)
		}
	}
	entry.pendingCommits = kept
	return resolved
}

// Decode one ReadResponse partition into messages. Pure w.r.t. flow-control (the
// caller charges bytes once per response). The FSM is tx-agnostic: tx read-offset
// tracking lives in the facade, which sees every delivered message.
let collectMessages = function collectMessages(partitionData: PartitionReadData): ReaderMessage[] {
	let messages: ReaderMessage[] = []

	for (let batch of partitionData.batches) {
		for (let md of batch.messageData) {
			messages.push({
				offset: md.offset,
				seqNo: md.seqNo,
				data: md.data,
				uncompressedSize: md.uncompressedSize,
				producer: batch.producerId,
				codec: batch.codec,
				...(md.createdAt && { createdAt: md.createdAt }),
				...(batch.writtenAt && { writtenAt: batch.writtenAt }),
				metadataItems: md.metadataItems,
			})
		}
	}

	return messages
}

// ── Server-stream event handlers ─────────────────────────────────────────────────

let readResponse = function readResponse(
	ctx: ReaderCtx,
	event: Extract<ReaderEvent, { type: 'reader.stream.read_response' }>,
	runtime: ReaderRuntime
): ReaderEffect[] {
	let groups: { session: TopicPartitionSession; messages: ReaderMessage[] }[] = []
	for (let partitionData of event.partitionData) {
		let partitionId = ctx.sessionIndex.get(partitionData.partitionSessionId)
		let entry = partitionId !== undefined ? ctx.partitions.get(partitionId) : undefined
		// Drop data for an unknown, superseded (stale session id after a reassign), or
		// no-longer-active partition.
		if (
			!entry ||
			entry.sessionId !== partitionData.partitionSessionId ||
			entry.state === 'stopped' ||
			entry.state === 'ended'
		) {
			continue
		}
		let messages = collectMessages(partitionData)
		if (messages.length > 0) {
			groups.push({ session: entry.session, messages })
		}
	}
	// Charge the whole response once and emit a single batch so the consumer releases
	// exactly bytesSize — several partitions in one response must not each claim the
	// full size. Emit even when everything was dropped so credit is still released.
	ctx.inFlightBytes += event.bytesSize
	runtime.emit({ type: 'reader.messages', releaseBytes: event.bytesSize, groups })
	return []
}

let startPartitionSession = function startPartitionSession(
	ctx: ReaderCtx,
	event: Extract<ReaderEvent, { type: 'reader.stream.start_partition' }>,
	runtime: ReaderRuntime
): ReaderEffect[] {
	let { partitionSessionId, partitionId, path, committedOffset, partitionOffsets } = event

	let entry = ctx.partitions.get(partitionId)
	let session = new TopicPartitionSession(partitionSessionId, partitionId, path)
	session.partitionOffsets = partitionOffsets
	session.partitionCommittedOffset = committedOffset

	if (entry === undefined) {
		entry = {
			partitionId,
			path,
			sessionId: partitionSessionId,
			session,
			partitionOffsets,
			partitionCommittedOffset: committedOffset,
			nextCommitStartOffset: committedOffset,
			state: 'active',
			pendingCommits: [],
		}
		ctx.partitions.set(partitionId, entry)
	} else {
		// Reconnect/reassign: drop the superseded session id from the index (so a late
		// message on the dead session can never misroute), install the fresh session
		// object + id, keep pending commits + the gap-fill anchor (never rewound below
		// server truth).
		ctx.sessionIndex.delete(entry.sessionId)
		entry.session = session
		entry.sessionId = partitionSessionId
		entry.path = path
		entry.partitionOffsets = partitionOffsets
		entry.partitionCommittedOffset = committedOffset
		entry.nextCommitStartOffset =
			entry.nextCommitStartOffset > committedOffset
				? entry.nextCommitStartOffset
				: committedOffset
		entry.state = 'active'
	}
	session.nextCommitStartOffset = entry.nextCommitStartOffset
	ctx.sessionIndex.set(partitionSessionId, partitionId)

	let effects: ReaderEffect[] = [
		{ type: 'reader.effect.timer.clear', which: 'partition_reassign_gc', partitionId },
	]

	// COMMIT RECONCILE: resolve pending already covered by committed_offset; re-send
	// the still-uncommitted remainder (narrowed to [committed_offset, end)) on the NEW
	// session id.
	for (let waiterId of drainCommits(entry, committedOffset)) {
		runtime.emit({ type: 'reader.commit.resolved', waiterId })
	}
	for (let pending of entry.pendingCommits) {
		if (pending.startOffset < committedOffset) {
			pending.startOffset = committedOffset
		}
		effects.push(
			commitEffect(partitionSessionId, [
				{ start: pending.startOffset, end: pending.endOffset },
			])
		)
	}

	runtime.emit({
		type: 'reader.partition.started',
		partitionId,
		partitionSessionId,
		committedOffset,
		session,
	})

	// The response's read/commit offsets may be overridden by the async
	// onPartitionSessionStart callback, so the runtime sends it from an effect.
	effects.push({
		type: 'reader.effect.partition.start_ack',
		partitionSessionId,
		partitionId,
		committedOffset,
		partitionOffsets,
	})
	return effects
}

let stopPartitionSession = function stopPartitionSession(
	ctx: ReaderCtx,
	event: Extract<ReaderEvent, { type: 'reader.stream.stop_partition' }>,
	runtime: ReaderRuntime
): ReaderEffect[] {
	let partitionId = ctx.sessionIndex.get(event.partitionSessionId)
	let entry = partitionId !== undefined ? ctx.partitions.get(partitionId) : undefined
	if (!entry || entry.state === 'stopped') {
		return []
	}

	if (!event.graceful) {
		// Immediate: give up the partition. Hold pending commits for reconcile if the
		// partition comes back; bound the wait with a gc timer (rebalanced-away case).
		entry.session.stop()
		entry.state = 'stopped'
		ctx.sessionIndex.delete(event.partitionSessionId)
		runtime.emit({
			type: 'reader.partition.stopped',
			partitionId: entry.partitionId,
			reason: 'lost',
		})
		if (entry.pendingCommits.length > 0) {
			return [
				{
					type: 'reader.effect.timer.schedule',
					which: 'partition_reassign_gc',
					partitionId: entry.partitionId,
				},
			]
		}
		return []
	}

	// Graceful: process pending commits, then respond. If already drained, respond now.
	if (entry.pendingCommits.length === 0) {
		entry.session.stop()
		entry.state = 'stopped'
		ctx.sessionIndex.delete(event.partitionSessionId)
		runtime.emit({
			type: 'reader.partition.stopped',
			partitionId: entry.partitionId,
			reason: 'graceful',
		})
		return [stopResponseEffect(event.partitionSessionId)]
	}

	entry.state = 'stopping-graceful'
	// The response is sent once pending commits drain (commit_response) or the graceful
	// timeout fires.
	return [{ type: 'reader.effect.timer.schedule', which: 'graceful_timeout' }]
}

let commitOffsetResponse = function commitOffsetResponse(
	ctx: ReaderCtx,
	event: Extract<ReaderEvent, { type: 'reader.stream.commit_response' }>,
	runtime: ReaderRuntime
): ReaderEffect[] {
	let effects: ReaderEffect[] = []
	for (let committed of event.committed) {
		let partitionId = ctx.sessionIndex.get(committed.partitionSessionId)
		let entry = partitionId !== undefined ? ctx.partitions.get(partitionId) : undefined
		if (!entry) {
			continue
		}
		if (committed.committedOffset > entry.partitionCommittedOffset) {
			entry.partitionCommittedOffset = committed.committedOffset
		}
		entry.session.partitionCommittedOffset = committed.committedOffset
		runtime.emit({
			type: 'reader.committed',
			partitionId: entry.partitionId,
			committedOffset: committed.committedOffset,
		})
		for (let waiterId of drainCommits(entry, committed.committedOffset)) {
			runtime.emit({ type: 'reader.commit.resolved', waiterId })
		}
		// A graceful stop that was waiting on these commits can now be acknowledged —
		// for the exact session the server asked to stop (== the acked one).
		if (entry.state === 'stopping-graceful' && entry.pendingCommits.length === 0) {
			entry.session.stop()
			entry.state = 'stopped'
			ctx.sessionIndex.delete(committed.partitionSessionId)
			runtime.emit({
				type: 'reader.partition.stopped',
				partitionId: entry.partitionId,
				reason: 'graceful',
			})
			effects.push(stopResponseEffect(committed.partitionSessionId))
		}
	}
	return effects
}

let endPartitionSession = function endPartitionSession(
	ctx: ReaderCtx,
	event: Extract<ReaderEvent, { type: 'reader.stream.end_partition' }>,
	runtime: ReaderRuntime
): void {
	let partitionId = ctx.sessionIndex.get(event.partitionSessionId)
	let entry = partitionId !== undefined ? ctx.partitions.get(partitionId) : undefined
	if (!entry) {
		return
	}
	// Partition fully read (split/merge). No response; keep the entry so pending
	// commits still reconcile against a future committed_offset or terminal shutdown.
	entry.session.end()
	entry.state = 'ended'
	runtime.emit({
		type: 'reader.partition.stopped',
		partitionId: entry.partitionId,
		reason: 'ended',
	})
}

// Dispatch a typed server-stream event to its handler. Returns effects to append.
let applyStreamEvent = function applyStreamEvent(
	ctx: ReaderCtx,
	event: ReaderStreamEvent,
	runtime: ReaderRuntime
): ReaderEffect[] {
	switch (event.type) {
		case 'reader.stream.read_response':
			return readResponse(ctx, event, runtime)
		case 'reader.stream.start_partition':
			return startPartitionSession(ctx, event, runtime)
		case 'reader.stream.stop_partition':
			return stopPartitionSession(ctx, event, runtime)
		case 'reader.stream.commit_response':
			return commitOffsetResponse(ctx, event, runtime)
		case 'reader.stream.end_partition':
			endPartitionSession(ctx, event, runtime)
			return []
	}
}

let isStreamEvent = function isStreamEvent(event: ReaderEvent): event is ReaderStreamEvent {
	return (
		event.type === 'reader.stream.read_response' ||
		event.type === 'reader.stream.start_partition' ||
		event.type === 'reader.stream.stop_partition' ||
		event.type === 'reader.stream.commit_response' ||
		event.type === 'reader.stream.end_partition'
	)
}

// Buffer a commit at the partition level; send it now if we have a live stream.
let recordCommit = function recordCommit(
	ctx: ReaderCtx,
	event: Extract<ReaderEvent, { type: 'reader.commit' }>,
	live: boolean,
	runtime: ReaderRuntime
): ReaderEffect[] {
	let entry = ctx.partitions.get(event.partitionId)
	if (!entry) {
		// The partition is gone (stopped + gc'd) — nothing can acknowledge it.
		runtime.emit({
			type: 'reader.commit.rejected',
			waiterId: event.waiterId,
			reason: new Error(`No active partition ${event.partitionId} to commit`),
		})
		return []
	}

	let ranges = buildCommitRanges(entry, event.offsets)
	if (ranges.length === 0) {
		runtime.emit({ type: 'reader.commit.resolved', waiterId: event.waiterId })
		return []
	}

	entry.pendingCommits.push({
		startOffset: ranges[0]!.start,
		endOffset: ranges[ranges.length - 1]!.end,
		waiterId: event.waiterId,
	})

	// Send only over a live, active session; while reconnecting we buffer and re-send
	// on the next start_partition.
	if (live && entry.state === 'active') {
		return [commitEffect(entry.sessionId, ranges)]
	}
	return []
}

// Consumer released `bytes`; replenish the server credit past a threshold.
let releaseBytes = function releaseBytes(ctx: ReaderCtx, bytes: bigint): ReaderEffect[] {
	ctx.inFlightBytes -= bytes
	if (ctx.inFlightBytes < 0n) {
		ctx.inFlightBytes = 0n
	}
	ctx.pendingReadRequestBytes += bytes

	let threshold = (ctx.limits.maxBufferBytes + 4n) / 5n // ceil-ish 20%
	if (ctx.pendingReadRequestBytes >= threshold) {
		let credit = ctx.pendingReadRequestBytes
		ctx.pendingReadRequestBytes = 0n
		return [readRequestEffect(credit)]
	}
	return []
}

// ── Terminal / transitions ──────────────────────────────────────────────────────

let terminate = function terminate(
	ctx: ReaderCtx,
	state: 'closed' | 'errored',
	reason: unknown,
	runtime: ReaderRuntime
): TransitionResult<ReaderState, ReaderEffect> {
	clearScheduling(ctx)

	if (state === 'errored') {
		ctx.lastError = reason
		runtime.emit({ type: 'reader.error', error: reason })
	}

	// Reject every outstanding commit exactly once — the facade settles the waiterId.
	for (let entry of ctx.partitions.values()) {
		for (let pending of entry.pendingCommits) {
			runtime.emit({ type: 'reader.commit.rejected', waiterId: pending.waiterId, reason })
		}
		entry.pendingCommits = []
	}

	runtime.emit({ type: 'reader.closed', reason })
	releaseState(ctx)

	return {
		state,
		effects: [
			{ type: 'reader.effect.transport.close' },
			{ type: 'reader.effect.timer.clear', which: 'start_timeout' },
			{ type: 'reader.effect.timer.clear', which: 'retry_backoff' },
			{ type: 'reader.effect.timer.clear', which: 'recovery_window' },
			{ type: 'reader.effect.timer.clear', which: 'update_token' },
			{ type: 'reader.effect.timer.clear', which: 'graceful_timeout' },
			{ type: 'reader.effect.finalize', reason },
		],
	}
}

let releaseState = function releaseState(ctx: ReaderCtx): void {
	ctx.partitions.clear()
	ctx.sessionIndex.clear()
	ctx.inFlightBytes = 0n
	ctx.pendingReadRequestBytes = 0n
}

// Enter `ready` on a successful init. Unlike the writer there is no seqNo recovery:
// the server re-sends start_partition per partition, where reconcile happens.
let toReady = function toReady(
	ctx: ReaderCtx,
	sessionId: string,
	runtime: ReaderRuntime
): TransitionResult<ReaderState, ReaderEffect> {
	ctx.sessionId = sessionId
	ctx.hasEverConnected = true
	ctx.attempts = 0
	clearScheduling(ctx)

	// Ephemeral session ids from the previous stream are dead; buffered ReadResponses
	// on it are gone. Reset flow-control and re-issue the full initial credit (the new
	// stream grants a fresh maxBufferBytes budget, so old pending credit is moot).
	ctx.sessionIndex.clear()
	ctx.inFlightBytes = 0n
	ctx.pendingReadRequestBytes = 0n

	runtime.emit({ type: 'reader.session', sessionId })

	return {
		state: 'ready',
		effects: [
			...clearConnectTimersEffects,
			{ type: 'reader.effect.timer.schedule', which: 'update_token' },
			readRequestEffect(ctx.limits.maxBufferBytes),
		],
	}
}

let toReconnecting = function toReconnecting(
	ctx: ReaderCtx,
	error: unknown,
	runtime: ReaderRuntime
): TransitionResult<ReaderState, ReaderEffect> {
	ctx.retryScheduled = true
	ctx.startTimeoutScheduled = false
	if (error !== undefined) {
		ctx.lastError = error
	}
	runtime.emit({
		type: 'reader.reconnecting',
		attempt: ctx.attempts,
		...(error !== undefined && { error }),
	})
	let effects: ReaderEffect[] = [
		{ type: 'reader.effect.timer.clear', which: 'start_timeout' },
		{ type: 'reader.effect.timer.clear', which: 'update_token' },
		{ type: 'reader.effect.timer.schedule', which: 'retry_backoff' },
	]
	// Arm the terminal deadline only when recovery is bounded. Unbounded (Infinity)
	// means reconnect forever — the transition owns that policy so the emitted effects
	// reflect it (model-testable), instead of the runtime silently dropping the timer.
	if (Number.isFinite(ctx.recoveryWindowMs)) {
		effects.push({ type: 'reader.effect.timer.schedule', which: 'recovery_window' })
	}
	return { state: 'reconnecting', effects }
}

let toClosing = function toClosing(
	ctx: ReaderCtx,
	runtime: ReaderRuntime
): TransitionResult<ReaderState, ReaderEffect> {
	ctx.startTimeoutScheduled = false
	if (!hasPendingWork(ctx)) {
		return terminate(ctx, 'closed', new Error('Reader closed'), runtime)
	}
	return {
		state: 'closing',
		effects: [
			// Closing may be entered while connecting/reconnecting — cancel those timers
			// so a stale start_timeout/retry_backoff/recovery_window cannot fire against
			// the closing drain.
			...clearConnectTimersEffects,
			{ type: 'reader.effect.timer.clear', which: 'update_token' },
			{ type: 'reader.effect.timer.schedule', which: 'graceful_timeout' },
		],
	}
}

let hasPendingWork = function hasPendingWork(ctx: ReaderCtx): boolean {
	for (let entry of ctx.partitions.values()) {
		if (entry.pendingCommits.length > 0 || entry.state === 'stopping-graceful') {
			return true
		}
	}
	return false
}

// A partition that was stopped (rebalanced away) and never came back: reject its
// still-pending commits so the caller is not left hanging (at-least-once redelivery
// covers correctness; the messages go to the partition's new owner).
let gcPartition = function gcPartition(
	ctx: ReaderCtx,
	partitionId: bigint,
	runtime: ReaderRuntime
): void {
	let entry = ctx.partitions.get(partitionId)
	if (!entry || entry.state !== 'stopped') {
		return
	}
	for (let pending of entry.pendingCommits) {
		runtime.emit({
			type: 'reader.commit.rejected',
			waiterId: pending.waiterId,
			reason: new Error(`Partition ${partitionId} reassigned before commit was acknowledged`),
		})
	}
	ctx.partitions.delete(partitionId)
}

// ── Transition ──────────────────────────────────────────────────────────────────

export let readerTransition = function readerTransition(
	ctx: ReaderCtx,
	event: ReaderEvent,
	runtime: ReaderRuntime
): TransitionResult<ReaderState, ReaderEffect> | void {
	let state = runtime.state

	// Global: hard destroy from any non-terminal state.
	if (state !== 'closed' && state !== 'errored' && event.type === 'reader.destroy') {
		return terminate(ctx, 'closed', event.reason ?? new Error('Reader destroyed'), runtime)
	}

	switch (state) {
		case 'idle': {
			if (event.type === 'reader.start') {
				ctx.startTimeoutScheduled = true
				return {
					state: 'connecting',
					effects: [
						{ type: 'reader.effect.transport.connect' },
						{ type: 'reader.effect.timer.schedule', which: 'start_timeout' },
					],
				}
			}
			if (event.type === 'reader.close') {
				return terminate(ctx, 'closed', new Error('Reader closed before start'), runtime)
			}
			return
		}

		case 'connecting':
		case 'reconnecting': {
			if (event.type === 'reader.stream.init_response') {
				return toReady(ctx, event.sessionId, runtime)
			}
			if (event.type === 'reader.commit') {
				// Buffer for re-send on the next start_partition (do not send on a
				// not-yet-ready stream).
				return { effects: recordCommit(ctx, event, false, runtime) }
			}
			if (
				event.type === 'reader.stream.disconnected' ||
				event.type === 'reader.timer.start_timeout'
			) {
				let error = event.type === 'reader.stream.disconnected' ? event.error : undefined
				if (
					event.type === 'reader.stream.disconnected' &&
					!isRetryableReaderError(error, ctx.retryOnSchemeError)
				) {
					return terminate(ctx, 'errored', error, runtime)
				}
				return toReconnecting(ctx, error, runtime)
			}
			if (event.type === 'reader.timer.retry_backoff' && state === 'reconnecting') {
				ctx.retryScheduled = false
				ctx.attempts += 1
				ctx.startTimeoutScheduled = true
				return {
					state: 'connecting',
					effects: [
						{ type: 'reader.effect.transport.connect' },
						{ type: 'reader.effect.timer.schedule', which: 'start_timeout' },
					],
				}
			}
			if (event.type === 'reader.timer.recovery_window') {
				return terminate(
					ctx,
					'errored',
					ctx.lastError ?? new Error('Reader recovery window expired'),
					runtime
				)
			}
			if (event.type === 'reader.close') {
				return toClosing(ctx, runtime)
			}
			return
		}

		case 'ready': {
			if (isStreamEvent(event)) {
				let effects = applyStreamEvent(ctx, event, runtime)
				return effects.length > 0 ? { effects } : undefined
			}
			if (event.type === 'reader.commit') {
				return { effects: recordCommit(ctx, event, true, runtime) }
			}
			if (event.type === 'reader.read_release') {
				let effects = releaseBytes(ctx, event.bytes)
				return effects.length > 0 ? { effects } : undefined
			}
			if (event.type === 'reader.timer.update_token') {
				return { effects: [{ type: 'reader.effect.transport.send_update_token' }] }
			}
			if (event.type === 'reader.timer.partition_reassign_gc') {
				gcPartition(ctx, event.partitionId, runtime)
				return
			}
			if (event.type === 'reader.stream.disconnected') {
				if (!isRetryableReaderError(event.error, ctx.retryOnSchemeError)) {
					return terminate(ctx, 'errored', event.error, runtime)
				}
				return toReconnecting(ctx, event.error, runtime)
			}
			if (event.type === 'reader.close') {
				return toClosing(ctx, runtime)
			}
			return
		}

		case 'closing': {
			if (isStreamEvent(event)) {
				let effects = applyStreamEvent(ctx, event, runtime)
				if (!hasPendingWork(ctx)) {
					return terminate(ctx, 'closed', new Error('Reader closed'), runtime)
				}
				return effects.length > 0 ? { effects } : undefined
			}
			if (event.type === 'reader.timer.graceful_timeout') {
				return terminate(ctx, 'closed', new Error('Reader closed'), runtime)
			}
			if (event.type === 'reader.stream.disconnected') {
				// A drop mid-close abandons any un-acked commits — finalize.
				return terminate(ctx, 'closed', new Error('Reader closed'), runtime)
			}
			if (event.type === 'reader.timer.partition_reassign_gc') {
				gcPartition(ctx, event.partitionId, runtime)
				if (!hasPendingWork(ctx)) {
					return terminate(ctx, 'closed', new Error('Reader closed'), runtime)
				}
				return
			}
			return
		}

		case 'closed':
		case 'errored':
			return
	}
}
