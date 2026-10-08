import type { Timestamp } from '@bufbuild/protobuf/wkt'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { loggers } from '@ydbjs/debug'
import { YDBError } from '@ydbjs/error'
import type { TransitionResult, TransitionRuntime } from '@ydbjs/fsm'
import { isRetryableStreamError } from '@ydbjs/retry'

import { TopicPartitionSession } from '../partition-session.js'

// The pure half of the reader: states, context, and a synchronous transition
// with no I/O. Mirrors writer-state.ts. The transport owns one streamRead
// stream and forwards server frames; the runtime's mapTransportOutput CLASSIFIES
// them into the typed `reader.stream.*` events below, so this transition works on
// clean domain events — never raw protobuf.
//
// The full transition map (table + diagram) lives in packages/topic/ARCHITECTURE.md —
// update it in the same commit when you change this dispatch.
//
// Partition state is keyed by the stable
// (topicPath, partitionId) pair — partitionKey() — never the ephemeral
// partitionSessionId (proto: "unique inside one RPC call"). partition_id alone is
// per-topic, so a multi-topic reader routinely sees the same id from several topics.
// Pending commits are held across reconnect and reconciled per-partition on each
// start_partition, so commit() is never rejected by a transparent reconnect.
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

// Half-open [start, end) offset interval — the only range shape on the wire.
export type OffsetRange = { start: bigint; end: bigint }

// Stable identity of a partition across reconnects. '|' cannot appear in a YDB
// scheme path, so the key is collision-free.
export let partitionKey = function partitionKey(path: string, partitionId: bigint): string {
	return `${path}|${partitionId}`
}

// Every commit call waits for the server watermark, including repeated requests
// for ranges already pending on the partition.
export type CommitWaiter = {
	targetOffset: bigint
	waiterId: number
}

// Everything the reader tracks about one partition, keyed by the stable partitionKey.
export type PartitionEntry = {
	// Each grant creates a new object, even when a new stream reuses the wire id.
	session: TopicPartitionSession
	// True from the grant until its start_ready is honored. While set, commits are
	// buffered (the ack performs the single send — a commit must never hit the wire
	// twice, nor before the start response), and the reassign gc treats the entry as
	// not-yet-live so a hung hook cannot strand commit() waiters forever.
	ackPending: boolean

	// offset tracking
	partitionCommittedOffset: bigint
	// A start response requests this offset but does not acknowledge its durability.
	requestedCommitOffset: bigint | undefined
	// Delivery watermark: end of the last delivered message's stitched commit range.
	// Reset to committed_offset on every grant (redelivery restarts there). Each
	// delivered message's commit range starts here, so server-side offset holes
	// (retention, readFrom skips) are attributed to the NEXT delivered message —
	// and a delivered-but-unacked message is never covered by another message's range.
	deliveredWatermark: bigint
	// Requested ranges not yet covered by the server watermark. They belong to the
	// partition, independently of how many commit promises await their confirmation.
	pendingRanges: OffsetRange[]

	// lifecycle
	state: 'active' | 'stopping-graceful' | 'stopped' | 'ended'
	// Graceful-stop handshake: set once the async onPartitionSessionStop hook
	// completed; the stop response goes out only when stopReady AND the pending
	// commits drained (either order), or the per-partition timeout escalates.
	stopReady: boolean
	commitWaiters: CommitWaiter[]
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
	// Start of this message's commit range (stitched at delivery time — covers the
	// server-side offset hole immediately preceding the message, if any).
	commitRangeStart: bigint
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
	sessionId: string | undefined

	// reconnect bookkeeping (mirrors the writer)
	attempts: number
	lastError: unknown
	// When set, a SCHEME_ERROR (e.g. the topic does not exist yet) is retried instead
	// of being fatal — the reader waits until the topic is created.
	retryOnSchemeError: boolean
	// Terminal reconnect deadline (ms). Infinity = unbounded (reconnect forever); the
	// transition owns whether to arm the `recovery_window` timer based on this.
	recoveryWindowMs: number

	// partition registry — keyed by the STABLE partitionKey (topicPath + partitionId)
	partitions: Map<string, PartitionEntry>
	// ephemeral partitionSessionId -> partitionKey, rebuilt each stream
	sessionIndex: Map<bigint, string>

	// Unreleased ReadResponse.bytesSize, including responses retained across reconnects.
	bufferedBytes: bigint

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
// effects/events carry a required partitionKey and key as `<name>:<partitionKey>`.
export type PartitionTimerName =
	| 'partition_graceful_timeout'
	| 'partition_reassign_gc'
	| 'partition_commit_status'

export type TimerName = GlobalTimerName | PartitionTimerName

// Timer control payload — partitionKey is required exactly when the name is partition_*.
export type TimerRef =
	| { which: GlobalTimerName }
	| { which: PartitionTimerName; partitionKey: string }

// Typed server-stream events, classified from the protobuf in mapTransportOutput.
export type ReaderStreamEvent =
	| { type: 'reader.stream.read_response'; partitionData: PartitionReadData[]; bytesSize: bigint }
	| {
			type: 'reader.stream.partition_status'
			partitionSessionId: bigint
			committedOffset: bigint
	  }
	| {
			type: 'reader.stream.start_partition'
			partitionSessionId: bigint
			partitionId: bigint
			path: string
			committedOffset: bigint
			partitionOffsets: OffsetRange
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
	| {
			type: 'reader.stream.end_partition'
			partitionSessionId: bigint
			childPartitionIds: bigint[]
			adjacentPartitionIds: bigint[]
	  }

export type ReaderEvent =
	// user (dispatched by the facade)
	| { type: 'reader.start' }
	// The facade builds the merged half-open ranges from the messages' stitched
	// commit-range starts; the transition clamps them against server truth.
	| { type: 'reader.commit'; partitionKey: string; ranges: OffsetRange[]; waiterId: number }
	| { type: 'reader.read_release'; bytes: bigint }
	| { type: 'reader.close' }
	| { type: 'reader.destroy'; reason?: unknown }
	| { type: 'reader.partition.forget'; session: TopicPartitionSession }
	// transport -> reader
	| { type: 'reader.stream.init_response'; sessionId: string }
	| ReaderStreamEvent
	| { type: 'reader.stream.disconnected'; error?: unknown }
	// The async onPartitionSessionStart hook finished (runs detached in the runtime so
	// user code never blocks the drain loop); carries the exact session it answers.
	| {
			type: 'reader.partition.start_ready'
			session: TopicPartitionSession
			readOffset?: bigint
			commitOffset?: bigint
	  }
	// The async onPartitionSessionStop hook finished for a graceful stop — the stop
	// response may go out once the pending commits drain too.
	| {
			type: 'reader.partition.stop_ready'
			session: TopicPartitionSession
	  }
	// timers
	| { type: 'reader.timer.start_timeout' }
	| { type: 'reader.timer.retry_backoff' }
	| { type: 'reader.timer.recovery_window' }
	| { type: 'reader.timer.update_token' }
	// The close() drain deadline armed by toClosing.
	| { type: 'reader.timer.graceful_timeout' }
	// Per-partition graceful-stop fallback.
	| { type: 'reader.timer.partition_graceful_timeout'; partitionKey: string }
	| { type: 'reader.timer.partition_reassign_gc'; partitionKey: string }
	| { type: 'reader.timer.partition_commit_status'; partitionKey: string }

export type ReaderEffect =
	| { type: 'reader.effect.transport.connect' }
	// Domain-level client messages; the runtime builds the protobuf wire frame (mirrors
	// the writer, whose transition emits MessageData and the runtime frames the request).
	| { type: 'reader.effect.send.read_request'; bytesSize: bigint }
	| {
			type: 'reader.effect.send.commit'
			partitionSessionId: bigint
			ranges: OffsetRange[]
	  }
	| { type: 'reader.effect.send.stop_response'; partitionSessionId: bigint }
	| { type: 'reader.effect.send.partition_status'; partitionSessionId: bigint }
	| {
			type: 'reader.effect.send.start_response'
			partitionSessionId: bigint
			readOffset?: bigint
			commitOffset?: bigint
	  }
	| { type: 'reader.effect.send.update_token' }
	// Runs the async onPartitionSessionStart callback then sends the response.
	| {
			type: 'reader.effect.partition.start_hook'
			session: TopicPartitionSession
			committedOffset: bigint
			partitionOffsets: OffsetRange
	  }
	// Runs the async onPartitionSessionStop callback for a graceful stop, then
	// dispatches reader.partition.stop_ready. The session is still committable while
	// the hook runs — this is the documented "last chance to commit".
	| {
			type: 'reader.effect.partition.stop_hook'
			session: TopicPartitionSession
			committedOffset: bigint
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
			session: TopicPartitionSession
	  }
	| {
			type: 'reader.partition.committed'
			partitionId: bigint
			committedOffset: bigint
			session: TopicPartitionSession
	  }
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
		sessionId: undefined,

		attempts: 0,
		lastError: undefined,
		retryOnSchemeError: options?.retryOnSchemeError ?? false,
		recoveryWindowMs: options?.recoveryWindowMs ?? Infinity,

		partitions: new Map(),
		sessionIndex: new Map(),

		bufferedBytes: 0n,

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
	return isRetryableStreamError(error)
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
	ranges: OffsetRange[]
): ReaderEffect {
	return { type: 'reader.effect.send.commit', partitionSessionId, ranges }
}

let stopResponseEffect = function stopResponseEffect(partitionSessionId: bigint): ReaderEffect {
	return { type: 'reader.effect.send.stop_response', partitionSessionId }
}

// ── Range algebra ───────────────────────────────────────────────────────────────
// All lists are kept sorted by start with no overlapping or touching neighbours.

// Merge a batch of ranges into normalized form (sort, join overlapping/adjacent).
export let mergeRanges = function mergeRanges(ranges: OffsetRange[]): OffsetRange[] {
	let sorted = ranges
		.filter((r) => r.end > r.start)
		.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
	let merged: OffsetRange[] = []
	for (let range of sorted) {
		let last = merged[merged.length - 1]
		if (last !== undefined && range.start <= last.end) {
			if (range.end > last.end) {
				last.end = range.end
			}
		} else {
			merged.push({ start: range.start, end: range.end })
		}
	}
	return merged
}

// Subtract `coverage` from `ranges` and clamp everything below `floor` — the
// remainder is what may still go on the wire without double-committing.
let subtractCovered = function subtractCovered(
	ranges: OffsetRange[],
	coverage: OffsetRange[],
	floor: bigint
): OffsetRange[] {
	let remainder: OffsetRange[] = []
	for (let range of ranges) {
		let start = range.start < floor ? floor : range.start
		let end = range.end
		for (let covered of coverage) {
			if (covered.end <= start) {
				continue
			}
			if (covered.start >= end) {
				break
			}
			if (covered.start > start) {
				remainder.push({ start, end: covered.start })
			}
			start = covered.end
			if (start >= end) {
				break
			}
		}
		if (start < end) {
			remainder.push({ start, end })
		}
	}
	return mergeRanges(remainder)
}

// Drop coverage the server already confirmed (everything below the watermark).
let compactCoverage = function compactCoverage(
	coverage: OffsetRange[],
	watermark: bigint
): OffsetRange[] {
	let compacted: OffsetRange[] = []
	for (let range of coverage) {
		if (range.end <= watermark) {
			continue
		}
		compacted.push({
			start: range.start < watermark ? watermark : range.start,
			end: range.end,
		})
	}
	return compacted
}

// Resolve pending commits already covered by a committed high-water mark; return the
// waiterIds to resolve. Used by both the commit-ack path and the reconnect reconcile.
let drainCommits = function drainCommits(entry: PartitionEntry, committedOffset: bigint): number[] {
	let resolved: number[] = []
	let kept: CommitWaiter[] = []
	for (let pending of entry.commitWaiters) {
		if (pending.targetOffset <= committedOffset) {
			resolved.push(pending.waiterId)
		} else {
			kept.push(pending)
		}
	}
	entry.commitWaiters = kept
	return resolved
}

// Re-grant reconcile preserves only unconfirmed coverage and pending waiters.
let narrowPendings = function narrowPendings(
	entry: PartitionEntry,
	committedOffset: bigint,
	runtime: ReaderRuntime
): void {
	for (let waiterId of drainCommits(entry, committedOffset)) {
		runtime.emit({ type: 'reader.commit.resolved', waiterId })
	}
	entry.pendingRanges = compactCoverage(entry.pendingRanges, committedOffset)
}

// Advance the server-confirmed committed watermark; emits partition.committed (the
// onCommittedOffset observer must see every advance — commit acks, stop_partition
// watermarks, and partition status responses alike). Returns true when it advanced.
let advanceCommitted = function advanceCommitted(
	entry: PartitionEntry,
	committedOffset: bigint,
	runtime: ReaderRuntime
): boolean {
	if (committedOffset <= entry.partitionCommittedOffset) {
		return false
	}
	entry.partitionCommittedOffset = committedOffset
	entry.session.partitionCommittedOffset = committedOffset
	entry.pendingRanges = compactCoverage(entry.pendingRanges, committedOffset)
	if (entry.deliveredWatermark < committedOffset) {
		entry.deliveredWatermark = committedOffset
	}
	runtime.emit({
		type: 'reader.partition.committed',
		partitionId: entry.session.partitionId,
		committedOffset,
		session: entry.session,
	})
	return true
}

// Decode one ReadResponse partition into messages, stitching each message's commit
// range start from the delivery watermark: server-side offset holes are attributed
// to the next delivered message, never to a later commit of an unrelated one. Pure
// w.r.t. flow-control (the caller charges bytes once per response). The FSM is
// tx-agnostic: tx read-offset tracking lives in the facade, which sees every
// delivered message.
let collectMessages = function collectMessages(
	entry: PartitionEntry,
	partitionData: PartitionReadData
): ReaderMessage[] {
	let messages: ReaderMessage[] = []

	for (let batch of partitionData.batches) {
		for (let md of batch.messageData) {
			let commitRangeStart =
				entry.deliveredWatermark < md.offset ? entry.deliveredWatermark : md.offset
			if (entry.deliveredWatermark < md.offset + 1n) {
				entry.deliveredWatermark = md.offset + 1n
			}
			messages.push({
				offset: md.offset,
				seqNo: md.seqNo,
				data: md.data,
				uncompressedSize: md.uncompressedSize,
				producer: batch.producerId,
				codec: batch.codec,
				commitRangeStart,
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
		let key = ctx.sessionIndex.get(partitionData.partitionSessionId)
		let entry = key !== undefined ? ctx.partitions.get(key) : undefined
		// Drop data for an unknown, superseded (stale session id after a reassign), or
		// no-longer-active partition. A gracefully stopping partition still delivers:
		// the server sends no NEW data after the stop request, but in-flight responses
		// belong to the app — the soft-stop contract is "finish processing and commit".
		if (
			!entry ||
			entry.session.partitionSessionId !== partitionData.partitionSessionId ||
			entry.state === 'stopped' ||
			entry.state === 'ended'
		) {
			continue
		}
		let messages = collectMessages(entry, partitionData)
		if (messages.length > 0) {
			groups.push({ session: entry.session, messages })
		}
	}
	// Charge the whole response once and emit a single batch so the consumer releases
	// exactly bytesSize — several partitions in one response must not each claim the
	// full size. Emit even when everything was dropped so credit is still released.
	ctx.bufferedBytes += event.bytesSize
	runtime.emit({ type: 'reader.messages', releaseBytes: event.bytesSize, groups })
	return []
}

// Create or refresh the registry entry for a (re)started partition, installing the
// fresh ephemeral grant. Pending commits survive (narrowed to server truth); the
// delivery watermark and claimed coverage restart from the committed offset.
let upsertPartitionEntry = function upsertPartitionEntry(
	ctx: ReaderCtx,
	event: Extract<ReaderEvent, { type: 'reader.stream.start_partition' }>,
	session: TopicPartitionSession
): PartitionEntry {
	let { partitionSessionId, partitionId, path, committedOffset } = event
	let key = partitionKey(path, partitionId)

	let entry = ctx.partitions.get(key)
	if (entry === undefined) {
		entry = {
			session,
			ackPending: true,

			partitionCommittedOffset: committedOffset,
			requestedCommitOffset: undefined,
			deliveredWatermark: committedOffset,
			pendingRanges: [],

			state: 'active',
			stopReady: false,
			commitWaiters: [],
		}
		ctx.partitions.set(key, entry)
	} else {
		// Reconnect/reassign: drop the superseded session id from the index (so a late
		// message on the dead session can never misroute), install the fresh session
		// object + id, keep pending commits for the reconcile in startPartitionSession.
		ctx.sessionIndex.delete(entry.session.partitionSessionId)
		entry.session = session
		entry.requestedCommitOffset = undefined
		// Server truth may only move the committed mark forward.
		if (entry.partitionCommittedOffset < committedOffset) {
			entry.partitionCommittedOffset = committedOffset
		}
		// Redelivery restarts at the committed offset — stitch from there again.
		entry.deliveredWatermark = entry.partitionCommittedOffset
		entry.state = 'active'
		entry.stopReady = false
		entry.ackPending = true
	}
	ctx.sessionIndex.set(partitionSessionId, key)
	return entry
}

let startPartitionSession = function startPartitionSession(
	ctx: ReaderCtx,
	event: Extract<ReaderEvent, { type: 'reader.stream.start_partition' }>,
	runtime: ReaderRuntime
): ReaderEffect[] {
	let { partitionSessionId, partitionId, path, committedOffset, partitionOffsets } = event
	let key = partitionKey(path, partitionId)

	let session = new TopicPartitionSession(partitionSessionId, partitionId, path)
	session.partitionOffsets = partitionOffsets
	session.partitionCommittedOffset = committedOffset
	let entry = upsertPartitionEntry(ctx, event, session)

	let effects: ReaderEffect[] = [
		{ type: 'reader.effect.timer.clear', which: 'partition_commit_status', partitionKey: key },
		// A stale graceful-stop fallback from the previous stream must not fire against
		// the freshly granted session.
		{
			type: 'reader.effect.timer.clear',
			which: 'partition_graceful_timeout',
			partitionKey: key,
		},
	]

	// COMMIT RECONCILE, half one: resolve pendings covered by committed_offset and
	// narrow the remainder ranges to [committed_offset, …). The re-send happens in
	// ackPartitionStart — after the start response — so a commit can never reach the
	// wire before the response that makes the session fully live (the reassign gc
	// also stays armed until then, bounding a hung onPartitionSessionStart hook).
	narrowPendings(entry, entry.partitionCommittedOffset, runtime)

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
		session,
		committedOffset,
		partitionOffsets,
	})
	return effects
}

let queuePartitionCleanup = function queuePartitionCleanup(
	entry: PartitionEntry,
	runtime: ReaderRuntime
): void {
	if (
		entry.commitWaiters.length === 0 &&
		entry.pendingRanges.length === 0 &&
		entry.requestedCommitOffset === undefined
	) {
		// Commits queued behind the stop can still be covered by its watermark.
		runtime.dispatch({ type: 'reader.partition.forget', session: entry.session })
	}
}

// Pending commits stay on the stopped entry until reconciliation completes.
let markStopped = function markStopped(
	ctx: ReaderCtx,
	entry: PartitionEntry,
	reason: 'graceful' | 'lost',
	runtime: ReaderRuntime
): void {
	entry.session.stop()
	entry.state = 'stopped'
	entry.requestedCommitOffset = undefined
	ctx.sessionIndex.delete(entry.session.partitionSessionId)
	runtime.emit({
		type: 'reader.partition.stopped',
		partitionId: entry.session.partitionId,
		reason,
		session: entry.session,
	})
	queuePartitionCleanup(entry, runtime)
}

let stopPartitionSession = function stopPartitionSession(
	ctx: ReaderCtx,
	event: Extract<ReaderEvent, { type: 'reader.stream.stop_partition' }>,
	runtime: ReaderRuntime
): ReaderEffect[] {
	let key = ctx.sessionIndex.get(event.partitionSessionId)
	let entry = key !== undefined ? ctx.partitions.get(key) : undefined
	if (!entry || key === undefined || entry.state === 'stopped') {
		return []
	}

	// The stop request carries the server's committed high-water mark — resolve every
	// pending commit it already covers before deciding whether anything is left to
	// wait for (otherwise a graceful stop waits on commits the server already holds).
	advanceCommitted(entry, event.committedOffset, runtime)
	let confirmedOverride =
		entry.requestedCommitOffset !== undefined &&
		entry.partitionCommittedOffset >= entry.requestedCommitOffset
	if (confirmedOverride) {
		entry.requestedCommitOffset = undefined
	}
	for (let waiterId of drainCommits(entry, entry.partitionCommittedOffset)) {
		runtime.emit({ type: 'reader.commit.resolved', waiterId })
	}

	if (!event.graceful) {
		// Immediate: give up the partition. Hold pending commits for reconcile if the
		// partition comes back; bound the wait with a gc timer (rebalanced-away case).
		markStopped(ctx, entry, 'lost', runtime)
		let effects: ReaderEffect[] = [
			{
				type: 'reader.effect.timer.clear',
				which: 'partition_commit_status',
				partitionKey: key,
			},
			// A pending graceful escalated to force — its fallback timer is obsolete.
			{
				type: 'reader.effect.timer.clear',
				which: 'partition_graceful_timeout',
				partitionKey: key,
			},
		]
		if (entry.commitWaiters.length > 0) {
			effects.push({
				type: 'reader.effect.timer.schedule',
				which: 'partition_reassign_gc',
				partitionKey: key,
			})
		}
		return effects
	}

	// Graceful (soft stop): the partition stays deliverable and committable while the
	// app finishes. The stop response goes out only after BOTH the async
	// onPartitionSessionStop hook completes (stop_ready) and the pending commits
	// drain — bounded by the per-partition timeout, since the server waits for the
	// response with no timeout of its own.
	entry.state = 'stopping-graceful'
	entry.stopReady = false
	let effects: ReaderEffect[] = [
		{
			type: 'reader.effect.partition.stop_hook',
			session: entry.session,
			committedOffset: entry.partitionCommittedOffset,
		},
		{
			type: 'reader.effect.timer.schedule',
			which: 'partition_graceful_timeout',
			partitionKey: key,
		},
	]
	if (confirmedOverride) {
		effects.push({
			type: 'reader.effect.timer.clear',
			which: 'partition_commit_status',
			partitionKey: key,
		})
	}
	return effects
}

// The async onPartitionSessionStart hook finished — answer the server, unless the
// grant was superseded while the hook ran: object identity pins the exact grant
// despite wire ids being reused across streams, and ackPending dedupes
// a double completion. Only now is the session fully live: the reassign gc is
// released and the pending commits are sent, strictly AFTER the start response and
// exactly once (recordCommit buffers while ackPending).
let ackPartitionStart = function ackPartitionStart(
	ctx: ReaderCtx,
	event: Extract<ReaderEvent, { type: 'reader.partition.start_ready' }>
): ReaderEffect[] {
	let key = partitionKey(event.session.topicPath, event.session.partitionId)
	let entry = ctx.partitions.get(key)
	if (!entry || entry.session !== event.session || !entry.ackPending) {
		return []
	}
	if (
		entry.state !== 'active' ||
		ctx.sessionIndex.get(entry.session.partitionSessionId) !== key
	) {
		return []
	}
	entry.ackPending = false

	// Start overrides have no commit ack. Suppress overlapping sends on this grant,
	// but retain pending ranges until a server watermark confirms the commit.
	if (event.commitOffset !== undefined && event.commitOffset > entry.partitionCommittedOffset) {
		entry.requestedCommitOffset = event.commitOffset
	}

	let effects: ReaderEffect[] = [
		{
			type: 'reader.effect.send.start_response',
			partitionSessionId: event.session.partitionSessionId,
			...(event.readOffset !== undefined && { readOffset: event.readOffset }),
			...(event.commitOffset !== undefined && { commitOffset: event.commitOffset }),
		},
		{
			type: 'reader.effect.timer.clear',
			which: 'partition_reassign_gc',
			partitionKey: key,
		},
	]
	let ranges = compactCoverage(
		entry.pendingRanges,
		entry.requestedCommitOffset ?? entry.partitionCommittedOffset
	)
	if (ranges.length > 0) {
		effects.push(commitEffect(entry.session.partitionSessionId, ranges))
	}
	if (entry.requestedCommitOffset !== undefined) {
		effects.push({
			type: 'reader.effect.send.partition_status',
			partitionSessionId: entry.session.partitionSessionId,
		})
	}
	return effects
}

// The async onPartitionSessionStop hook finished — the graceful stop may be
// acknowledged once the pending commits drain too. Guards mirror ackPartitionStart:
// session identity pins the grant, state pins the phase (a force stop or reconnect while the
// hook ran makes this a no-op).
let ackPartitionStop = function ackPartitionStop(
	ctx: ReaderCtx,
	event: Extract<ReaderEvent, { type: 'reader.partition.stop_ready' }>,
	runtime: ReaderRuntime
): ReaderEffect[] {
	let key = partitionKey(event.session.topicPath, event.session.partitionId)
	let entry = ctx.partitions.get(key)
	if (!entry || entry.session !== event.session || entry.state !== 'stopping-graceful') {
		return []
	}
	entry.stopReady = true
	if (entry.commitWaiters.length > 0 || entry.requestedCommitOffset !== undefined) {
		return []
	}
	let sessionId = entry.session.partitionSessionId
	let live = ctx.sessionIndex.get(sessionId) === key
	markStopped(ctx, entry, 'graceful', runtime)
	let effects: ReaderEffect[] = [
		{
			type: 'reader.effect.timer.clear',
			which: 'partition_commit_status',
			partitionKey: key,
		},
		{
			type: 'reader.effect.timer.clear',
			which: 'partition_graceful_timeout',
			partitionKey: key,
		},
	]
	// Answer only over the stream that asked (session ids restart per stream).
	if (live) {
		effects.push(stopResponseEffect(sessionId))
	}
	return effects
}

// A graceful stop that never became answerable in time (hook hung or commits never
// drained): acknowledge the stop anyway (the server otherwise waits forever and the
// partition is never handed off) and fall back to the force-stop bookkeeping —
// pending commits stay for a possible reconcile, bounded by the reassign gc.
let forceStopStalledGraceful = function forceStopStalledGraceful(
	ctx: ReaderCtx,
	key: string,
	runtime: ReaderRuntime
): ReaderEffect[] {
	let entry = ctx.partitions.get(key)
	if (!entry || entry.state !== 'stopping-graceful') {
		return []
	}
	let effects: ReaderEffect[] = [
		{ type: 'reader.effect.timer.clear', which: 'partition_commit_status', partitionKey: key },
	]
	entry.session.stop()
	entry.state = 'stopped'
	entry.requestedCommitOffset = undefined
	runtime.emit({
		type: 'reader.partition.stopped',
		partitionId: entry.session.partitionId,
		reason: 'graceful',
		session: entry.session,
	})
	// Answer the server only when the session id still belongs to THIS stream (same
	// predicate as recordCommit): server-assigned ids restart at 1 per stream, so a
	// stale id from before a reconnect likely names a different, freshly granted
	// partition — releasing it is session-fatal (BAD_REQUEST) and deleting its index
	// mapping would silently drop that partition's reads. A stale stop needs no
	// answer at all: the server re-requests it on the new session if still relevant.
	if (ctx.sessionIndex.get(entry.session.partitionSessionId) === key) {
		ctx.sessionIndex.delete(entry.session.partitionSessionId)
		effects.push(stopResponseEffect(entry.session.partitionSessionId))
	}
	if (entry.commitWaiters.length > 0) {
		effects.push({
			type: 'reader.effect.timer.schedule',
			which: 'partition_reassign_gc',
			partitionKey: key,
		})
	}
	queuePartitionCleanup(entry, runtime)
	return effects
}

let commitOffsetResponse = function commitOffsetResponse(
	ctx: ReaderCtx,
	event: Extract<ReaderEvent, { type: 'reader.stream.commit_response' }>,
	runtime: ReaderRuntime
): ReaderEffect[] {
	let effects: ReaderEffect[] = []
	for (let committed of event.committed) {
		let key = ctx.sessionIndex.get(committed.partitionSessionId)
		let entry = key !== undefined ? ctx.partitions.get(key) : undefined
		if (!entry || key === undefined) {
			continue
		}
		advanceCommitted(entry, committed.committedOffset, runtime)
		if (
			entry.requestedCommitOffset !== undefined &&
			entry.partitionCommittedOffset >= entry.requestedCommitOffset
		) {
			entry.requestedCommitOffset = undefined
			effects.push({
				type: 'reader.effect.timer.clear',
				which: 'partition_commit_status',
				partitionKey: key,
			})
		}
		for (let waiterId of drainCommits(entry, entry.partitionCommittedOffset)) {
			runtime.emit({ type: 'reader.commit.resolved', waiterId })
		}
		// A graceful stop that was waiting on these commits can now be acknowledged —
		// once the stop hook has completed too — for the exact session the server
		// asked to stop (== the acked one).
		if (
			entry.state === 'stopping-graceful' &&
			entry.stopReady &&
			entry.requestedCommitOffset === undefined &&
			entry.commitWaiters.length === 0
		) {
			markStopped(ctx, entry, 'graceful', runtime)
			effects.push(stopResponseEffect(committed.partitionSessionId), {
				type: 'reader.effect.timer.clear',
				which: 'partition_graceful_timeout',
				partitionKey: key,
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
	let key = ctx.sessionIndex.get(event.partitionSessionId)
	let entry = key !== undefined ? ctx.partitions.get(key) : undefined
	if (!entry) {
		return
	}
	// Partition fully read (autopartitioning split/merge). No response; keep the entry
	// AND its session index so pending/late commits still reach the wire — the session
	// stays open for commits until the server stops it. The child/adjacent partition
	// ids are recorded on the session for autoscaling-aware consumers.
	entry.session.end(event.childPartitionIds, event.adjacentPartitionIds)
	entry.state = 'ended'
	runtime.emit({
		type: 'reader.partition.stopped',
		partitionId: entry.session.partitionId,
		reason: 'ended',
		session: entry.session,
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
		case 'reader.stream.partition_status': {
			let effects = commitOffsetResponse(
				ctx,
				{
					type: 'reader.stream.commit_response',
					committed: [
						{
							partitionSessionId: event.partitionSessionId,
							committedOffset: event.committedOffset,
						},
					],
				},
				runtime
			)
			let key = ctx.sessionIndex.get(event.partitionSessionId)
			let entry = key !== undefined ? ctx.partitions.get(key) : undefined
			if (entry?.requestedCommitOffset !== undefined && key !== undefined) {
				effects.push({
					type: 'reader.effect.timer.schedule',
					which: 'partition_commit_status',
					partitionKey: key,
				})
			}
			return effects
		}
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
	let entry = ctx.partitions.get(event.partitionKey)
	if (!entry) {
		// The partition is gone (stopped + gc'd) — nothing can acknowledge it.
		runtime.emit({
			type: 'reader.commit.rejected',
			waiterId: event.waiterId,
			reason: new Error(`No active partition ${event.partitionKey} to commit`),
		})
		return []
	}

	let requestedRanges = mergeRanges(event.ranges)
	let targetOffset = requestedRanges.at(-1)?.end ?? entry.partitionCommittedOffset
	if (targetOffset <= entry.partitionCommittedOffset) {
		runtime.emit({ type: 'reader.commit.resolved', waiterId: event.waiterId })
		return []
	}

	// Clamp to server truth and subtract already-claimed coverage: a duplicate or
	// overlapping range on the wire is session-fatal. A fully claimed commit still
	// remains pending until the server confirms its target watermark.
	let wireRanges = subtractCovered(
		requestedRanges,
		entry.pendingRanges,
		entry.partitionCommittedOffset
	)

	// A commit can lose the race with the partition stop: the facade dispatches while
	// the session is still live, but a commit_response or stop request queued ahead of
	// it completes the stop first. Uncovered offsets of a stopped partition can never
	// be acknowledged on this stream (the server ignores commits after the stop), and
	// the messages will be redelivered wherever the partition lands — reject now
	// instead of parking the waiter on the reassign gc.
	if (entry.state === 'stopped') {
		runtime.emit({
			type: 'reader.commit.rejected',
			waiterId: event.waiterId,
			reason: new Error(
				`Cannot commit offsets for a stopped or expired partition session (partition ${event.partitionKey})`
			),
		})
		return []
	}

	entry.commitWaiters.push({ targetOffset, waiterId: event.waiterId })
	entry.pendingRanges = mergeRanges([...entry.pendingRanges, ...wireRanges])

	// An initialized stream can commit while retained responses delay its first read request.
	// initializeSession clears sessionIndex and only start_partition repopulates it, so a commit
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
		(runtime.state === 'ready' ||
			(runtime.state === 'connecting' && ctx.sessionId !== undefined)) &&
		ctx.sessionIndex.get(entry.session.partitionSessionId) === event.partitionKey
	let committable =
		entry.state === 'active' || entry.state === 'stopping-graceful' || entry.state === 'ended'
	if (sessionLive && committable && !entry.ackPending && wireRanges.length > 0) {
		let ranges = compactCoverage(
			wireRanges,
			entry.requestedCommitOffset ?? entry.partitionCommittedOffset
		)
		return ranges.length > 0 ? [commitEffect(entry.session.partitionSessionId, ranges)] : []
	}
	return []
}

let startReading = function startReading(
	ctx: ReaderCtx
): TransitionResult<ReaderState, ReaderEffect> {
	let bytes = ctx.limits.maxBufferBytes - ctx.bufferedBytes
	return bytes > 0n
		? { state: 'ready', effects: [readRequestEffect(bytes)] }
		: { state: 'connecting' }
}

let releaseBytes = function releaseBytes(
	ctx: ReaderCtx,
	bytes: bigint,
	state: ReaderState
): TransitionResult<ReaderState, ReaderEffect> | void {
	if (bytes <= 0n) {
		return
	}
	let released = bytes < ctx.bufferedBytes ? bytes : ctx.bufferedBytes
	ctx.bufferedBytes -= released
	if (state === 'ready') {
		// The facade releases each complete response once, using its server-supplied bytesSize.
		return { effects: released > 0n ? [readRequestEffect(released)] : [] }
	}
	if (state === 'connecting' && ctx.sessionId !== undefined) {
		return startReading(ctx)
	}
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
		for (let pending of entry.commitWaiters) {
			runtime.emit({ type: 'reader.commit.rejected', waiterId: pending.waiterId, reason })
		}
		entry.commitWaiters = []
	}

	runtime.emit({ type: 'reader.closed', reason })
	releaseState(ctx)

	return {
		state,
		// Terminal: the runtime seals itself after the finalize effect runs, so the
		// buffered lifecycle outputs (reader.closed / rejects) are delivered first.
		final: { reason },
		effects: [{ type: 'reader.effect.finalize', reason }],
	}
}

export let releaseState = function releaseState(ctx: ReaderCtx): void {
	ctx.partitions.clear()
	ctx.sessionIndex.clear()
	ctx.bufferedBytes = 0n
	ctx.sessionId = undefined
}

// Initialize the session before granting read credit; retained responses may keep
// the reader connecting while partition control and commits already run.
let initializeSession = function initializeSession(
	ctx: ReaderCtx,
	sessionId: string,
	runtime: ReaderRuntime
): TransitionResult<ReaderState, ReaderEffect> {
	ctx.sessionId = sessionId
	ctx.attempts = 0
	ctx.sessionIndex.clear()

	runtime.emit({ type: 'reader.session', sessionId })

	let effects: ReaderEffect[] = [
		...clearConnectTimersEffects,
		{ type: 'reader.effect.timer.schedule', which: 'update_token' },
	]

	// Bound the wait for every partition holding pending commits: if the server does
	// not re-grant it on this stream (rebalanced to another reader), the gc rejects
	// the waiters instead of leaving them pending forever. start_partition clears the
	// timer when the partition does come back.
	for (let [key, entry] of ctx.partitions) {
		if (entry.commitWaiters.length > 0) {
			effects.push({
				type: 'reader.effect.timer.schedule',
				which: 'partition_reassign_gc',
				partitionKey: key,
			})
		}
	}

	let reading = startReading(ctx)
	return { ...reading, effects: [...effects, ...(reading.effects ?? [])] }
}

let toReconnecting = function toReconnecting(
	ctx: ReaderCtx,
	error: unknown,
	runtime: ReaderRuntime
): TransitionResult<ReaderState, ReaderEffect> {
	// sessionIndex means "session ids granted by the CURRENT stream" — with the stream
	// gone there are none. Clearing here (not only on init) keeps the guards in
	// recordCommit / forceStopStalledGraceful honest while connecting: nothing may be
	// sent under an id the next stream never granted.
	ctx.sessionIndex.clear()
	ctx.sessionId = undefined
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
	for (let key of ctx.partitions.keys()) {
		effects.push({
			type: 'reader.effect.timer.clear',
			which: 'partition_commit_status',
			partitionKey: key,
		})
	}
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
		if (
			entry.commitWaiters.length > 0 ||
			entry.requestedCommitOffset !== undefined ||
			entry.state === 'stopping-graceful'
		) {
			return true
		}
	}
	return false
}

// A partition that was stopped (rebalanced away) and never came back: reject its
// still-pending commits so the caller is not left hanging (at-least-once redelivery
// covers correctness; the messages go to the partition's new owner).
let gcPartition = function gcPartition(ctx: ReaderCtx, key: string, runtime: ReaderRuntime): void {
	let entry = ctx.partitions.get(key)
	if (!entry) {
		return
	}
	// A granted-and-acked session is live — the ack cleared this timer, so a firing
	// against it is a stale race; ignore it.
	if (ctx.sessionIndex.get(entry.session.partitionSessionId) === key && !entry.ackPending) {
		return
	}
	// Two reapable cases: the partition was never re-granted on this stream
	// (rebalanced to another reader), or it was granted but the start handshake never
	// completed (a hung onPartitionSessionStart hook) — either way the waiters would
	// hang until terminal close. Reject them; keep an un-acked granted entry so a
	// late start_ready can still answer the server (it just has nothing to re-send).
	for (let pending of entry.commitWaiters) {
		runtime.emit({
			type: 'reader.commit.rejected',
			waiterId: pending.waiterId,
			reason: new Error(`Partition ${key} reassigned before commit was acknowledged`),
		})
	}
	entry.commitWaiters = []
	entry.pendingRanges = []
	if (ctx.sessionIndex.get(entry.session.partitionSessionId) !== key) {
		ctx.partitions.delete(key)
	}
}

// ── Transition ──────────────────────────────────────────────────────────────────

// Deliberately-ignored (state, event) pairs route through here so an unhandled
// event shows up in debug logs instead of vanishing.
let ignored = function ignored(state: ReaderState, event: ReaderEvent): void {
	dbg.log('ignoring %s in state %s', event.type, state)
}

let sessionTransition = function sessionTransition(
	ctx: ReaderCtx,
	event: ReaderEvent,
	runtime: ReaderRuntime
): TransitionResult<ReaderState, ReaderEffect> | void {
	let state = runtime.state
	switch (event.type) {
		case 'reader.stream.read_response':
		case 'reader.stream.start_partition':
		case 'reader.stream.stop_partition':
		case 'reader.stream.commit_response':
		case 'reader.stream.partition_status':
		case 'reader.stream.end_partition': {
			let effects = applyStreamEvent(ctx, event, runtime)
			return { effects }
		}

		case 'reader.commit':
			return { effects: recordCommit(ctx, event, runtime) }

		case 'reader.partition.start_ready': {
			let effects = ackPartitionStart(ctx, event)
			return { effects }
		}

		case 'reader.partition.stop_ready': {
			let effects = ackPartitionStop(ctx, event, runtime)
			return { effects }
		}

		case 'reader.timer.update_token':
			return { effects: [{ type: 'reader.effect.send.update_token' }] }

		case 'reader.timer.partition_reassign_gc':
			gcPartition(ctx, event.partitionKey, runtime)
			return

		// Fallback for a graceful stop whose hook or commits never completed: the
		// server waits for the stop response indefinitely, so the client must not.
		case 'reader.timer.partition_graceful_timeout': {
			let effects = forceStopStalledGraceful(ctx, event.partitionKey, runtime)
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

export let readerTransition = function readerTransition(
	ctx: ReaderCtx,
	event: ReaderEvent,
	runtime: ReaderRuntime
): TransitionResult<ReaderState, ReaderEffect> | void {
	let state = runtime.state

	if (event.type === 'reader.partition.forget') {
		let key = partitionKey(event.session.topicPath, event.session.partitionId)
		let entry = ctx.partitions.get(key)
		if (
			entry?.session === event.session &&
			entry.state === 'stopped' &&
			entry.commitWaiters.length === 0 &&
			entry.pendingRanges.length === 0 &&
			entry.requestedCommitOffset === undefined
		) {
			ctx.partitions.delete(key)
		}
		return
	}

	// Global: hard destroy from any non-terminal state.
	if (state !== 'closed' && state !== 'errored' && event.type === 'reader.destroy') {
		return terminate(ctx, 'closed', event.reason ?? new Error('Reader destroyed'), runtime)
	}
	if (state !== 'closed' && state !== 'errored' && event.type === 'reader.read_release') {
		return releaseBytes(ctx, event.bytes, state)
	}
	if (
		(state === 'ready' ||
			state === 'closing' ||
			(state === 'connecting' && ctx.sessionId !== undefined)) &&
		event.type === 'reader.timer.partition_commit_status'
	) {
		let entry = ctx.partitions.get(event.partitionKey)
		if (
			entry?.requestedCommitOffset !== undefined &&
			ctx.sessionIndex.get(entry.session.partitionSessionId) === event.partitionKey
		) {
			return {
				effects: [
					{
						type: 'reader.effect.send.partition_status',
						partitionSessionId: entry.session.partitionSessionId,
					},
				],
			}
		}
		return
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
			if (state === 'connecting' && ctx.sessionId !== undefined) {
				return sessionTransition(ctx, event, runtime)
			}
			switch (event.type) {
				case 'reader.stream.init_response':
					return initializeSession(ctx, event.sessionId, runtime)

				case 'reader.commit':
					// Buffered for re-send on the next start_partition (recordCommit never
					// sends before the new session has initialized).
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
					let effects = forceStopStalledGraceful(ctx, event.partitionKey, runtime)
					return { effects }
				}

				case 'reader.timer.partition_reassign_gc':
					gcPartition(ctx, event.partitionKey, runtime)
					return

				case 'reader.close':
					return toClosing(ctx, runtime)

				default:
					return ignored(state, event)
			}
		}

		case 'ready':
			return sessionTransition(ctx, event, runtime)

		case 'closing': {
			switch (event.type) {
				case 'reader.stream.read_response':
				case 'reader.stream.start_partition':
				case 'reader.stream.stop_partition':
				case 'reader.stream.commit_response':
				case 'reader.stream.partition_status':
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
					let effects = ackPartitionStart(ctx, event)
					return { effects }
				}

				// The graceful-stop drain continues during close(); a completed stop hook
				// may finish the drain and with it the whole close.
				case 'reader.partition.stop_ready': {
					let effects = ackPartitionStop(ctx, event, runtime)
					if (!hasPendingWork(ctx)) {
						return terminate(ctx, 'closed', new Error('Reader closed'), runtime)
					}
					return { effects }
				}

				// Per-partition fallback (armed in ready) — force-stop that partition and
				// keep draining; only the global close deadline finalizes the reader.
				case 'reader.timer.partition_graceful_timeout': {
					let effects = forceStopStalledGraceful(ctx, event.partitionKey, runtime)
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
					gcPartition(ctx, event.partitionKey, runtime)
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
