import type { Timestamp } from '@bufbuild/protobuf/wkt'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { loggers } from '@ydbjs/debug'
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
// The full transition map (table + diagram) lives in packages/topic/ARCHITECTURE.md —
// update it in the same commit when you change this dispatch.
//
// KEY DESIGN (see project decisions): all reader state is keyed by the STABLE
// partitionId, never the ephemeral partitionSessionId (proto: "unique inside one
// RPC call"). Pending commits are held across reconnect and reconciled per-partition
// on each start_partition, so commit() is never rejected by a transparent reconnect.
// Commit promises live in the facade keyed by waiterId — the transition holds no
// callbacks, which keeps it model-testable.

let dbg = loggers.topic.extend('reader')

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
export type PartitionEntry = {
	// identity — stable across reconnects
	partitionId: bigint
	path: string

	// current ephemeral grant (replaced on each reconnect/reassign)
	partitionSessionId: bigint
	session: TopicPartitionSession
	// Identity of the latest grant (start_partition), stamped through the async
	// onPartitionSessionStart handshake: partition session ids restart at 1 per
	// stream, so without it a hook completing after a reconnect could answer a NEW
	// grant that reused the id — the server kills the session for a double response.
	grantId: number
	// True from the grant until its start_ready is honored. While set, commits are
	// buffered (the ack performs the single send — a commit must never hit the wire
	// twice, nor before the start response), and the reassign gc treats the entry as
	// not-yet-live so a hung hook cannot strand commit() waiters forever.
	ackPending: boolean

	// offset tracking
	partitionOffsets: { start: bigint; end: bigint }
	partitionCommittedOffset: bigint
	// Gap-fill anchor: the start of the next commit range. Survives reconnect and is
	// never rewound below a start_partition committed_offset (see startPartitionSession).
	nextCommitStartOffset: bigint

	// lifecycle
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
		// Optional protobuf message fields are `T | undefined` (protoc-gen-es honours
		// exactOptionalPropertyTypes): present-but-unset must be assignable here.
		writtenAt?: Timestamp | undefined
		messageData: {
			offset: bigint
			seqNo: bigint
			data: Uint8Array
			uncompressedSize: bigint
			createdAt?: Timestamp | undefined
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
	// connection identity
	sessionId: string
	hasEverConnected: boolean

	// reconnect bookkeeping (mirrors the writer)
	attempts: number
	lastError: unknown
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
	// monotonic grant counter — source of PartitionEntry.grantId
	grantSeq: number

	// byte flow-control
	inFlightBytes: bigint
	pendingReadRequestBytes: bigint

	limits: ReaderLimits
}

export type GlobalTimerName =
	| 'start_timeout'
	| 'retry_backoff'
	| 'recovery_window'
	| 'update_token'
	// The close() drain deadline armed by toClosing.
	| 'graceful_timeout'

// Per-partition timers — the `partition_` prefix IS the scoping marker: their
// effects/events carry a required partitionId and key as `<name>:<partitionId>`.
export type PartitionTimerName = 'partition_graceful_timeout' | 'partition_reassign_gc'

export type TimerName = GlobalTimerName | PartitionTimerName

// Timer control payload — partitionId is required exactly when the name is partition_*.
export type TimerRef =
	| { which: GlobalTimerName }
	| { which: PartitionTimerName; partitionId: bigint }

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
	// The async onPartitionSessionStart hook finished (runs detached in the runtime so
	// user code never blocks the drain loop); carries the hook's offset overrides and
	// the grantId of the grant it answers (guards against stale completions).
	| {
			type: 'reader.partition.start_ready'
			partitionSessionId: bigint
			partitionId: bigint
			grantId: number
			readOffset?: bigint
			commitOffset?: bigint
	  }
	// timers
	| { type: 'reader.timer.start_timeout' }
	| { type: 'reader.timer.retry_backoff' }
	| { type: 'reader.timer.recovery_window' }
	| { type: 'reader.timer.update_token' }
	// The close() drain deadline armed by toClosing.
	| { type: 'reader.timer.graceful_timeout' }
	// Per-partition graceful-stop fallback.
	| { type: 'reader.timer.partition_graceful_timeout'; partitionId: bigint }
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
	| {
			type: 'reader.effect.send.start_response'
			partitionSessionId: bigint
			readOffset?: bigint
			commitOffset?: bigint
	  }
	| { type: 'reader.effect.send.update_token' }
	| { type: 'reader.effect.transport.close' }
	// Runs the async onPartitionSessionStart callback then sends the response.
	| {
			type: 'reader.effect.partition.start_hook'
			partitionSessionId: bigint
			partitionId: bigint
			grantId: number
			committedOffset: bigint
			partitionOffsets: { start: bigint; end: bigint }
	  }
	| ({ type: 'reader.effect.timer.schedule' } & TimerRef)
	| ({ type: 'reader.effect.timer.clear' } & TimerRef)
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
	| { type: 'reader.partition.committed'; partitionId: bigint; committedOffset: bigint }
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
		retryOnSchemeError: options?.retryOnSchemeError ?? false,
		recoveryWindowMs: options?.recoveryWindowMs ?? Infinity,

		partitions: new Map(),
		sessionIndex: new Map(),
		grantSeq: 0,

		inFlightBytes: 0n,
		pendingReadRequestBytes: 0n,

		limits,
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
// offsets) and the first message. Advances nextCommitStartOffset (never rewinds it).
let buildCommitRanges = function buildCommitRanges(
	entry: PartitionEntry,
	offsets: bigint[]
): { start: bigint; end: bigint }[] {
	let ranges: { start: bigint; end: bigint }[] = []
	for (let offset of offsets) {
		// Already covered by the commit high-water mark (re-committed message, or a
		// redelivery below the anchor). Skipping is load-bearing, not just tidy: a
		// zero-width or inverted OffsetsRange is session-fatal — the server answers
		// CloseSession(BAD_REQUEST "double committing is forbidden").
		if (offset + 1n <= entry.nextCommitStartOffset) {
			continue
		}
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
			entry.partitionSessionId !== partitionData.partitionSessionId ||
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

// Create or refresh the registry entry for a (re)started partition, installing the
// fresh ephemeral grant. Pending commits and the gap-fill anchor survive.
let upsertPartitionEntry = function upsertPartitionEntry(
	ctx: ReaderCtx,
	event: Extract<ReaderEvent, { type: 'reader.stream.start_partition' }>,
	session: TopicPartitionSession
): PartitionEntry {
	let { partitionSessionId, partitionId, path, committedOffset, partitionOffsets } = event

	let entry = ctx.partitions.get(partitionId)
	ctx.grantSeq += 1
	if (entry === undefined) {
		entry = {
			partitionId,
			path,

			partitionSessionId,
			session,
			grantId: ctx.grantSeq,
			ackPending: true,

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
		// object + id, keep pending commits + the gap-fill anchor.
		ctx.sessionIndex.delete(entry.partitionSessionId)
		entry.session = session
		entry.partitionSessionId = partitionSessionId
		entry.path = path
		entry.partitionOffsets = partitionOffsets
		entry.partitionCommittedOffset = committedOffset
		// Never rewind the gap-fill anchor below server truth.
		if (entry.nextCommitStartOffset < committedOffset) {
			entry.nextCommitStartOffset = committedOffset
		}
		entry.state = 'active'
		entry.grantId = ctx.grantSeq
		entry.ackPending = true
	}
	ctx.sessionIndex.set(partitionSessionId, partitionId)
	return entry
}

let startPartitionSession = function startPartitionSession(
	ctx: ReaderCtx,
	event: Extract<ReaderEvent, { type: 'reader.stream.start_partition' }>,
	runtime: ReaderRuntime
): ReaderEffect[] {
	let { partitionSessionId, partitionId, path, committedOffset, partitionOffsets } = event

	let session = new TopicPartitionSession(partitionSessionId, partitionId, path)
	session.partitionOffsets = partitionOffsets
	session.partitionCommittedOffset = committedOffset
	let entry = upsertPartitionEntry(ctx, event, session)

	let effects: ReaderEffect[] = [
		// A stale graceful-stop fallback from the previous stream must not fire against
		// the freshly granted session.
		{ type: 'reader.effect.timer.clear', which: 'partition_graceful_timeout', partitionId },
	]

	// COMMIT RECONCILE, half one: resolve pending already covered by committed_offset
	// and narrow the remainder to [committed_offset, end). The re-send happens in
	// ackPartitionStart — after the start response — so a commit can never reach the
	// wire before the response that makes the session fully live (the reassign gc
	// also stays armed until then, bounding a hung onPartitionSessionStart hook).
	for (let waiterId of drainCommits(entry, committedOffset)) {
		runtime.emit({ type: 'reader.commit.resolved', waiterId })
	}
	for (let pending of entry.pendingCommits) {
		if (pending.startOffset < committedOffset) {
			pending.startOffset = committedOffset
		}
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
		type: 'reader.effect.partition.start_hook',
		partitionSessionId,
		partitionId,
		grantId: entry.grantId,
		committedOffset,
		partitionOffsets,
	})
	return effects
}

// Retire a partition session: mark it stopped, drop it from the ephemeral index,
// and notify the facade. Pending commits stay on the entry for reconcile/gc.
let markStopped = function markStopped(
	ctx: ReaderCtx,
	entry: PartitionEntry,
	reason: 'graceful' | 'lost',
	runtime: ReaderRuntime
): void {
	entry.session.stop()
	entry.state = 'stopped'
	ctx.sessionIndex.delete(entry.partitionSessionId)
	runtime.emit({ type: 'reader.partition.stopped', partitionId: entry.partitionId, reason })
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

	// The stop request carries the server's committed high-water mark — resolve every
	// pending commit it already covers before deciding whether anything is left to
	// wait for (otherwise a graceful stop waits on commits the server already holds).
	if (event.committedOffset > entry.partitionCommittedOffset) {
		entry.partitionCommittedOffset = event.committedOffset
		entry.session.partitionCommittedOffset = event.committedOffset
	}
	for (let waiterId of drainCommits(entry, event.committedOffset)) {
		runtime.emit({ type: 'reader.commit.resolved', waiterId })
	}

	if (!event.graceful) {
		// Immediate: give up the partition. Hold pending commits for reconcile if the
		// partition comes back; bound the wait with a gc timer (rebalanced-away case).
		markStopped(ctx, entry, 'lost', runtime)
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
		markStopped(ctx, entry, 'graceful', runtime)
		return [stopResponseEffect(event.partitionSessionId)]
	}

	entry.state = 'stopping-graceful'
	// The response is sent once pending commits drain (commit_response) or the
	// per-partition graceful timeout fires — the server waits for the response with no
	// timeout of its own, so the fallback must exist and must not collide across
	// concurrently stopping partitions.
	return [
		{
			type: 'reader.effect.timer.schedule',
			which: 'partition_graceful_timeout',
			partitionId: entry.partitionId,
		},
	]
}

// The async onPartitionSessionStart hook finished — answer the server, unless the
// grant was superseded while the hook ran: grantId pins the exact grant (session ids
// collide across reconnects — they restart at 1 per stream), and ackPending dedupes
// a double completion. Only now is the session fully live: the reassign gc is
// released and the pending commits are sent, strictly AFTER the start response and
// exactly once (recordCommit buffers while ackPending).
let ackPartitionStart = function ackPartitionStart(
	ctx: ReaderCtx,
	event: Extract<ReaderEvent, { type: 'reader.partition.start_ready' }>,
	runtime: ReaderRuntime
): ReaderEffect[] {
	let entry = ctx.partitions.get(event.partitionId)
	if (!entry || entry.grantId !== event.grantId || !entry.ackPending) {
		return []
	}
	if (
		entry.state !== 'active' ||
		ctx.sessionIndex.get(entry.partitionSessionId) !== entry.partitionId
	) {
		return []
	}
	entry.ackPending = false

	// A commitOffset override moves the server's committed mark: reconcile pending
	// commits against it exactly like startPartitionSession does with the server's
	// committed offset — resolve fully covered waiters, narrow the rest, advance the
	// gap-fill anchor. Re-sending a range below the override is session-fatal.
	if (event.commitOffset !== undefined) {
		for (let waiterId of drainCommits(entry, event.commitOffset)) {
			runtime.emit({ type: 'reader.commit.resolved', waiterId })
		}
		for (let pending of entry.pendingCommits) {
			if (pending.startOffset < event.commitOffset) {
				pending.startOffset = event.commitOffset
			}
		}
		if (event.commitOffset > entry.nextCommitStartOffset) {
			entry.nextCommitStartOffset = event.commitOffset
		}
	}

	let effects: ReaderEffect[] = [
		{
			type: 'reader.effect.send.start_response',
			partitionSessionId: event.partitionSessionId,
			...(event.readOffset !== undefined && { readOffset: event.readOffset }),
			...(event.commitOffset !== undefined && { commitOffset: event.commitOffset }),
		},
		{
			type: 'reader.effect.timer.clear',
			which: 'partition_reassign_gc',
			partitionId: entry.partitionId,
		},
	]
	// The single send of everything buffered for this partition (reconciled pendings
	// from before the reconnect and commits issued during the hook window alike).
	for (let pending of entry.pendingCommits) {
		effects.push(
			commitEffect(entry.partitionSessionId, [
				{ start: pending.startOffset, end: pending.endOffset },
			])
		)
	}
	return effects
}

// A graceful stop whose pending commits never drained in time: acknowledge the stop
// anyway (the server otherwise waits forever and the partition is never handed off)
// and fall back to the force-stop bookkeeping — pending commits stay for a possible
// reconcile, bounded by the reassign gc.
let forceStopStalledGraceful = function forceStopStalledGraceful(
	ctx: ReaderCtx,
	partitionId: bigint,
	runtime: ReaderRuntime
): ReaderEffect[] {
	let effects: ReaderEffect[] = []
	for (let entry of ctx.partitions.values()) {
		if (entry.state !== 'stopping-graceful') {
			continue
		}
		if (entry.partitionId !== partitionId) {
			continue
		}
		entry.session.stop()
		entry.state = 'stopped'
		runtime.emit({
			type: 'reader.partition.stopped',
			partitionId: entry.partitionId,
			reason: 'graceful',
		})
		// Answer the server only when the session id still belongs to THIS stream (same
		// predicate as recordCommit): server-assigned ids restart at 1 per stream, so a
		// stale id from before a reconnect likely names a different, freshly granted
		// partition — releasing it is session-fatal (BAD_REQUEST) and deleting its index
		// mapping would silently drop that partition's reads. A stale stop needs no
		// answer at all: the server re-requests it on the new session if still relevant.
		if (ctx.sessionIndex.get(entry.partitionSessionId) === entry.partitionId) {
			ctx.sessionIndex.delete(entry.partitionSessionId)
			effects.push(stopResponseEffect(entry.partitionSessionId))
		}
		if (entry.pendingCommits.length > 0) {
			effects.push({
				type: 'reader.effect.timer.schedule',
				which: 'partition_reassign_gc',
				partitionId: entry.partitionId,
			})
		}
	}
	return effects
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
			type: 'reader.partition.committed',
			partitionId: entry.partitionId,
			committedOffset: committed.committedOffset,
		})
		for (let waiterId of drainCommits(entry, committed.committedOffset)) {
			runtime.emit({ type: 'reader.commit.resolved', waiterId })
		}
		// A graceful stop that was waiting on these commits can now be acknowledged —
		// for the exact session the server asked to stop (== the acked one).
		if (entry.state === 'stopping-graceful' && entry.pendingCommits.length === 0) {
			markStopped(ctx, entry, 'graceful', runtime)
			effects.push(stopResponseEffect(committed.partitionSessionId), {
				type: 'reader.effect.timer.clear',
				which: 'partition_graceful_timeout',
				partitionId: entry.partitionId,
			})
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

// Buffer a commit at the partition level; send it now if we have a live stream.
let recordCommit = function recordCommit(
	ctx: ReaderCtx,
	event: Extract<ReaderEvent, { type: 'reader.commit' }>,
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

	// Send only in `ready` and only over a session granted by the CURRENT stream:
	// toReady clears sessionIndex and only start_partition repopulates it, so a commit
	// landing in the init→start_partition window after a reconnect buffers here and
	// rides the reconcile — sending immediately would use the previous stream's
	// session id.
	// 'stopping-graceful' still sends: the protocol accepts commits until the client
	// responds to the stop request, and the commit_response drain relies on them.
	// 'ended' sends too — end_partition is informational (partition fully read); the
	// session stays open for commits until the server stops it.
	// While a grant's start handshake is outstanding (ackPending) the commit is
	// buffered too: the ack performs the single send — sending here AND there would
	// put the same range on the wire twice, which is session-fatal.
	let sessionLive =
		runtime.state === 'ready' &&
		ctx.sessionIndex.get(entry.partitionSessionId) === entry.partitionId
	let committable =
		entry.state === 'active' || entry.state === 'stopping-graceful' || entry.state === 'ended'
	if (sessionLive && committable && !entry.ackPending) {
		return [commitEffect(entry.partitionSessionId, ranges)]
	}
	return []
}

// Re-grant server read credit only once at least 1/5 of the buffer budget is
// pending — batches the ReadRequests instead of sending one per consumed response.
let CREDIT_REGRANT_DIVISOR = 5n

// Consumer released `bytes`; replenish the server credit past a threshold.
let releaseBytes = function releaseBytes(ctx: ReaderCtx, bytes: bigint): ReaderEffect[] {
	ctx.inFlightBytes -= bytes
	if (ctx.inFlightBytes < 0n) {
		ctx.inFlightBytes = 0n
	}
	ctx.pendingReadRequestBytes += bytes

	// Ceil division so a budget smaller than the divisor still yields a non-zero
	// threshold.
	let threshold =
		(ctx.limits.maxBufferBytes + CREDIT_REGRANT_DIVISOR - 1n) / CREDIT_REGRANT_DIVISOR
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
		// Terminal: the runtime seals itself after the finalize effect runs, so the
		// buffered lifecycle outputs (reader.closed / rejects) are delivered first.
		final: { reason },
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

	// Ephemeral session ids from the previous stream are dead; buffered ReadResponses
	// on it are gone. Reset flow-control and re-issue the full initial credit (the new
	// stream grants a fresh maxBufferBytes budget, so old pending credit is moot).
	ctx.sessionIndex.clear()
	ctx.inFlightBytes = 0n
	ctx.pendingReadRequestBytes = 0n

	runtime.emit({ type: 'reader.session', sessionId })

	let effects: ReaderEffect[] = [
		...clearConnectTimersEffects,
		{ type: 'reader.effect.timer.schedule', which: 'update_token' },
		readRequestEffect(ctx.limits.maxBufferBytes),
	]

	// Bound the wait for every partition holding pending commits: if the server does
	// not re-grant it on this stream (rebalanced to another reader), the gc rejects
	// the waiters instead of leaving them pending forever. start_partition clears the
	// timer when the partition does come back.
	for (let entry of ctx.partitions.values()) {
		if (entry.pendingCommits.length > 0) {
			effects.push({
				type: 'reader.effect.timer.schedule',
				which: 'partition_reassign_gc',
				partitionId: entry.partitionId,
			})
		}
	}

	return { state: 'ready', effects }
}

let toReconnecting = function toReconnecting(
	ctx: ReaderCtx,
	error: unknown,
	runtime: ReaderRuntime
): TransitionResult<ReaderState, ReaderEffect> {
	// sessionIndex means "session ids granted by the CURRENT stream" — with the stream
	// gone there are none. Clearing here (not only in toReady) keeps the guards in
	// recordCommit / forceStopStalledGraceful honest while connecting: nothing may be
	// sent under an id the next stream never granted.
	ctx.sessionIndex.clear()
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
	if (!entry) {
		return
	}
	// A granted-and-acked session is live — the ack cleared this timer, so a firing
	// against it is a stale race; ignore it.
	if (ctx.sessionIndex.get(entry.partitionSessionId) === entry.partitionId && !entry.ackPending) {
		return
	}
	// Two reapable cases: the partition was never re-granted on this stream
	// (rebalanced to another reader), or it was granted but the start handshake never
	// completed (a hung onPartitionSessionStart hook) — either way the waiters would
	// hang until terminal close. Reject them; keep an un-acked granted entry so a
	// late start_ready can still answer the server (it just has nothing to re-send).
	for (let pending of entry.pendingCommits) {
		runtime.emit({
			type: 'reader.commit.rejected',
			waiterId: pending.waiterId,
			reason: new Error(`Partition ${partitionId} reassigned before commit was acknowledged`),
		})
	}
	entry.pendingCommits = []
	if (ctx.sessionIndex.get(entry.partitionSessionId) !== entry.partitionId) {
		ctx.partitions.delete(partitionId)
	}
}

// ── Transition ──────────────────────────────────────────────────────────────────

// Deliberately-ignored (state, event) pairs route through here so an unhandled
// event shows up in debug logs instead of vanishing.
let ignored = function ignored(state: ReaderState, event: ReaderEvent): void {
	dbg.log('ignoring %s in state %s', event.type, state)
}

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
			switch (event.type) {
				case 'reader.start':
					return {
						state: 'connecting',
						effects: [
							{ type: 'reader.effect.transport.connect' },
							{ type: 'reader.effect.timer.schedule', which: 'start_timeout' },
						],
					}

				case 'reader.close':
					return terminate(
						ctx,
						'closed',
						new Error('Reader closed before start'),
						runtime
					)

				default:
					return ignored(state, event)
			}
		}

		case 'connecting':
		case 'reconnecting': {
			switch (event.type) {
				case 'reader.stream.init_response':
					return toReady(ctx, event.sessionId, runtime)

				case 'reader.commit':
					// Buffered for re-send on the next start_partition (recordCommit never
					// sends outside `ready`).
					return { effects: recordCommit(ctx, event, runtime) }

				case 'reader.stream.disconnected':
				case 'reader.timer.start_timeout': {
					let error =
						event.type === 'reader.stream.disconnected' ? event.error : undefined
					if (
						event.type === 'reader.stream.disconnected' &&
						!isRetryableReaderError(error, ctx.retryOnSchemeError)
					) {
						return terminate(ctx, 'errored', error, runtime)
					}
					return toReconnecting(ctx, error, runtime)
				}

				case 'reader.timer.retry_backoff':
					if (state === 'reconnecting') {
						ctx.attempts += 1
						return {
							state: 'connecting',
							effects: [
								{ type: 'reader.effect.transport.connect' },
								{ type: 'reader.effect.timer.schedule', which: 'start_timeout' },
							],
						}
					}
					// A stale backoff firing while already connecting has nothing to do.
					return ignored(state, event)

				case 'reader.timer.recovery_window':
					return terminate(
						ctx,
						'errored',
						ctx.lastError ?? new Error('Reader recovery window expired'),
						runtime
					)

				// Partition timers armed in `ready` survive the disconnect edge — handle
				// them here so a stalled graceful stop / lost partition is still bounded.
				// forceStopStalledGraceful suppresses the stop_response for sessions the
				// current stream did not grant; the server re-requests the stop on the next
				// session if the rebalance is still in progress.
				case 'reader.timer.partition_graceful_timeout': {
					let effects = forceStopStalledGraceful(ctx, event.partitionId, runtime)
					return { effects }
				}

				case 'reader.timer.partition_reassign_gc':
					gcPartition(ctx, event.partitionId, runtime)
					return

				case 'reader.close':
					return toClosing(ctx, runtime)

				default:
					return ignored(state, event)
			}
		}

		case 'ready': {
			switch (event.type) {
				case 'reader.stream.read_response':
				case 'reader.stream.start_partition':
				case 'reader.stream.stop_partition':
				case 'reader.stream.commit_response':
				case 'reader.stream.end_partition': {
					let effects = applyStreamEvent(ctx, event, runtime)
					return { effects }
				}

				case 'reader.commit':
					return { effects: recordCommit(ctx, event, runtime) }

				case 'reader.partition.start_ready': {
					let effects = ackPartitionStart(ctx, event, runtime)
					return { effects }
				}

				case 'reader.read_release': {
					let effects = releaseBytes(ctx, event.bytes)
					return { effects }
				}

				case 'reader.timer.update_token':
					return { effects: [{ type: 'reader.effect.send.update_token' }] }

				case 'reader.timer.partition_reassign_gc':
					gcPartition(ctx, event.partitionId, runtime)
					return

				// Fallback for a graceful stop whose commits never drained: the server waits
				// for the stop response indefinitely, so the client must not.
				case 'reader.timer.partition_graceful_timeout': {
					let effects = forceStopStalledGraceful(ctx, event.partitionId, runtime)
					return { effects }
				}

				case 'reader.stream.disconnected':
					if (!isRetryableReaderError(event.error, ctx.retryOnSchemeError)) {
						return terminate(ctx, 'errored', event.error, runtime)
					}
					return toReconnecting(ctx, event.error, runtime)

				case 'reader.close':
					return toClosing(ctx, runtime)

				default:
					return ignored(state, event)
			}
		}

		case 'closing': {
			switch (event.type) {
				case 'reader.stream.read_response':
				case 'reader.stream.start_partition':
				case 'reader.stream.stop_partition':
				case 'reader.stream.commit_response':
				case 'reader.stream.end_partition': {
					let effects = applyStreamEvent(ctx, event, runtime)
					if (!hasPendingWork(ctx)) {
						return terminate(ctx, 'closed', new Error('Reader closed'), runtime)
					}
					return { effects }
				}

				// start_partition is honored during the closing drain, so its async hook
				// completion must be answered here too.
				case 'reader.partition.start_ready': {
					let effects = ackPartitionStart(ctx, event, runtime)
					return { effects }
				}

				// Per-partition fallback (armed in ready) — force-stop that partition and
				// keep draining; only the global close deadline finalizes the reader.
				case 'reader.timer.partition_graceful_timeout': {
					let effects = forceStopStalledGraceful(ctx, event.partitionId, runtime)
					if (!hasPendingWork(ctx)) {
						return terminate(ctx, 'closed', new Error('Reader closed'), runtime)
					}
					return { effects }
				}

				case 'reader.timer.graceful_timeout':
					return terminate(ctx, 'closed', new Error('Reader closed'), runtime)

				case 'reader.stream.disconnected':
					// A drop mid-close abandons any un-acked commits — finalize.
					return terminate(ctx, 'closed', new Error('Reader closed'), runtime)

				case 'reader.timer.partition_reassign_gc':
					gcPartition(ctx, event.partitionId, runtime)
					if (!hasPendingWork(ctx)) {
						return terminate(ctx, 'closed', new Error('Reader closed'), runtime)
					}
					return

				default:
					return ignored(state, event)
			}
		}

		case 'closed':
		case 'errored':
			return ignored(state, event)
	}
}
