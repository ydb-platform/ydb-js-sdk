import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { YDBError } from '@ydbjs/error'
import { expect, test } from 'vitest'

import type { TopicPartitionSession } from '../partition-session.ts'

import {
	type OffsetRange,
	type ReaderCtx,
	type ReaderEffect,
	type ReaderEvent,
	type ReaderOutput,
	type ReaderState,
	createReaderCtx,
	partitionKey,
	readerTransition,
} from './reader-state.ts'
type TransportEvent =
	| { type: 'transport.connect' }
	| { type: 'transport.destroy'; reason?: unknown }
	| { type: 'transport.init'; sessionId: string }
	| { type: 'transport.message'; message: unknown }
	| { type: 'transport.ended' }
	| { type: 'transport.error'; error: unknown }

// Model-based / property test. The reader transition runs against an independent
// connection and server model, driven by consumer calls, commits, network events,
// server assignments/deliveries (with server-side offset holes)/acks,
// server-initiated partition stops (graceful AND force) and timer firings —
// including the per-partition partition_graceful_timeout and partition_reassign_gc
// — checking invariants after every step. Commits are generated the way the facade
// builds them: per delivered message [commitRangeStart, offset+1), merged — the
// model mirrors the delivery-time stitching and asserts every delivered message's
// commitRangeStart continues exactly where the previous delivery (or the grant's
// committed offset) left off. The graceful-stop handshake is modeled too: the
// stop_hook effect completes as a randomly interleaved stop_ready, and a stop
// response is legal only after BOTH stop_ready and drained commits (or the
// per-partition timeout escalation).
//
// The crux is commit-reconcile across reconnect and partition churn: a commit must
// never be rejected by a transparent reconnect, a resolved commit must be covered
// by a server-reported committed watermark, wire commit
// ranges must be ascending, non-overlapping, never below the server's committed
// offset, and never cover an offset outside the committing messages' own stitched
// ranges — i.e. never a delivered-but-uncommitted message someone else still holds.
// A stop_response is sent at most once per partition session, no data may surface
// for a force-stopped session, and after the cooldown every waiter must have
// settled. The only legal rejections are the reassign gc (partition rebalanced
// away before its commits were acknowledged) and a terminal shutdown — any other
// rejection is a bug. Partitions are keyed by the stable (path, partitionId) pair,
// and the multi-partition run reuses one partitionId across two topics to pin the
// composite keying.

let mulberry32 = function mulberry32(seed: number): () => number {
	let a = seed >>> 0
	return function next(): number {
		a = (a + 0x6d2b79f5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

let NEVER = new AbortController().signal

// ── model-side range algebra (independent of the implementation under test) ─────

let modelMerge = function modelMerge(ranges: OffsetRange[]): OffsetRange[] {
	let sorted = ranges
		.filter((r) => r.end > r.start)
		.map((r) => ({ start: r.start, end: r.end }))
		.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
	let merged: OffsetRange[] = []
	for (let range of sorted) {
		let last = merged[merged.length - 1]
		if (last !== undefined && range.start <= last.end) {
			if (range.end > last.end) {
				last.end = range.end
			}
		} else {
			merged.push(range)
		}
	}
	return merged
}

let clampRanges = function clampRanges(ranges: OffsetRange[], floor: bigint): OffsetRange[] {
	let clamped: OffsetRange[] = []
	for (let range of ranges) {
		if (range.end <= floor) {
			continue
		}
		clamped.push({ start: range.start < floor ? floor : range.start, end: range.end })
	}
	return clamped
}

let sameRanges = function sameRanges(a: OffsetRange[], b: OffsetRange[]): boolean {
	if (a.length !== b.length) {
		return false
	}
	return a.every((r, i) => r.start === b[i]!.start && r.end === b[i]!.end)
}

let overlapsAny = function overlapsAny(range: OffsetRange, list: OffsetRange[]): boolean {
	return list.some((r) => r.start < range.end && range.start < r.end)
}

let coveredBy = function coveredBy(ranges: OffsetRange[], coverage: OffsetRange[]): boolean {
	let merged = modelMerge(coverage)
	return ranges.every((range) => merged.some((c) => c.start <= range.start && range.end <= c.end))
}

let assertNormalized = function assertNormalized(ranges: OffsetRange[], label: string): void {
	let prevEnd = -1n
	for (let range of ranges) {
		if (range.start >= range.end) {
			throw new Error(`${label}: malformed range [${range.start}, ${range.end})`)
		}
		if (range.start < prevEnd) {
			throw new Error(`${label}: descending or overlapping ranges on the wire`)
		}
		prevEnd = range.end
	}
}

// ── server / consumer model ─────────────────────────────────────────────────────

type ServerPartition = {
	path: string
	partitionId: bigint
	key: string // partitionKey(path, partitionId) — the stable identity
	durableCommitted: bigint // committed watermark; the only commit state that survives the session
	sessionRanges: OffsetRange[] // sparse committed ranges beyond the watermark; die with the session
	availableUpTo: bigint // server holds offsets [0, availableUpTo) minus delivery-time holes
	deliveredUpTo: bigint // send cursor on the current stream
	partitionSessionId: bigint | undefined // ephemeral id, set on assign, cleared on stop/reconnect
	ready: boolean // client sent StartPartitionSessionResponse
	stopping: boolean // graceful stop pending the client's response
	unackedCommits: number // commit requests applied on the current session, not yet acked
}

// What the consumer holds for one partition on the CURRENT grant: each delivered
// message's stitched commit range, in delivery order. `nextStitch` is the model's
// independent delivery watermark — every delivered message's commitRangeStart must
// continue exactly here (D2: server-side holes attributed to the next delivered
// message, never to a later commit of an unrelated one).
type MirrorMessage = { start: bigint; end: bigint; requested: boolean }
type Mirror = { nextStitch: bigint; msgs: MirrorMessage[] }

type Waiter = {
	partitionKey: string
	ranges: OffsetRange[] // the merged stitched ranges this commit() asked for
	endOffset: bigint
	state: 'pending' | 'resolved' | 'rejected'
	rejectReason?: unknown
}

type Sim = {
	readerState: ReaderState
	readerCtx: ReaderCtx
	readerEvents: ReaderEvent[]
	transportEvents: TransportEvent[]

	armed: Set<string> // timer keys: `which` or `which:partitionKey`

	streamOpen: boolean
	initPending: boolean
	credit: bigint // server flow-control: sum(ReadRequest.bytesSize) - sum(ReadResponse.bytesSize)
	nextSessionId: bigint
	sessionCounter: number
	nextWaiterId: number

	partitions: ServerPartition[]
	byKey: Map<string, ServerPartition>
	waiters: Map<number, Waiter>
	unreleased: bigint[] // reader.messages releaseBytes emitted, not yet released by the consumer

	mirrors: Map<string, Mirror>
	// Union of every range any commit() ever asked for, per partition — the wire
	// must never carry an offset outside it (that offset would belong to a
	// delivered-but-uncommitted message, or to nobody).
	requestedUnion: Map<string, OffsetRange[]>

	// The async onPartitionSessionStop hook: the stop_hook effect queues here and a
	// randomly interleaved action completes it as reader.partition.stop_ready.
	pendingStopHooks: TopicPartitionSession[]
	stopReadyDone: Set<TopicPartitionSession> // hook completed for that grant
	gracefulTimeoutFired: Set<string> // partitionKey — the escalation legalizing an early stop_response

	// Session ids are globally unique here (nextSessionId is monotonic), so both sets
	// can track per-session facts across streams without collisions.
	stopResponded: Set<bigint> // sessions already released via stop_response (a duplicate is session-fatal)
	forceStopped: Set<bigint> // sessions killed by a force stop — no reader.messages may follow

	committedSeen: Map<string, bigint> // partitionKey -> last committed offset seen (monotonic check)
	terminal: boolean
}

let mkSim = function mkSim(
	topology: { path: string; partitionId: bigint }[],
	maxBufferBytes: bigint
): Sim {
	let partitions: ServerPartition[] = topology.map(({ path, partitionId }) => ({
		path,
		partitionId,
		key: partitionKey(path, partitionId),
		durableCommitted: 0n,
		sessionRanges: [],
		availableUpTo: 0n,
		deliveredUpTo: 0n,
		partitionSessionId: undefined,
		ready: false,
		stopping: false,
		unackedCommits: 0,
	}))
	return {
		readerState: 'idle',
		readerCtx: createReaderCtx({ maxBufferBytes }),
		readerEvents: [],
		transportEvents: [],
		armed: new Set(),
		streamOpen: false,
		initPending: false,
		credit: 0n,
		nextSessionId: 1n,
		sessionCounter: 0,
		nextWaiterId: 1,
		partitions,
		byKey: new Map(partitions.map((p) => [p.key, p])),
		waiters: new Map(),
		unreleased: [],
		mirrors: new Map(),
		requestedUnion: new Map(),
		pendingStopHooks: [],
		stopReadyDone: new Set(),
		gracefulTimeoutFired: new Set(),
		stopResponded: new Set(),
		forceStopped: new Set(),
		committedSeen: new Map(),
		terminal: false,
	}
}

// Mirror of reader-runtime.ts classifyServerMessage — the transport forwards raw
// server frames, and this classifies them into typed reader events.
let classify = function classify(message: any): ReaderEvent | null {
	let server = message.serverMessage
	switch (server.case) {
		case 'readResponse':
			return {
				type: 'reader.stream.read_response',
				partitionData: server.value.partitionData,
				bytesSize: server.value.bytesSize,
			}
		case 'startPartitionSessionRequest': {
			let ps = server.value.partitionSession
			return {
				type: 'reader.stream.start_partition',
				partitionSessionId: ps.partitionSessionId,
				partitionId: ps.partitionId,
				path: ps.path,
				committedOffset: server.value.committedOffset,
				partitionOffsets: server.value.partitionOffsets,
			}
		}
		case 'stopPartitionSessionRequest':
			return {
				type: 'reader.stream.stop_partition',
				partitionSessionId: server.value.partitionSessionId,
				graceful: server.value.graceful,
				committedOffset: server.value.committedOffset,
			}
		case 'commitOffsetResponse':
			return {
				type: 'reader.stream.commit_response',
				committed: server.value.partitionsCommittedOffsets,
			}
		case 'partitionSessionStatusResponse':
			return {
				type: 'reader.stream.partition_status',
				partitionSessionId: server.value.partitionSessionId,
				committedOffset: server.value.committedOffset,
			}
		case 'endPartitionSession':
			return {
				type: 'reader.stream.end_partition',
				partitionSessionId: server.value.partitionSessionId,
				childPartitionIds: server.value.childPartitionIds ?? [],
				adjacentPartitionIds: server.value.adjacentPartitionIds ?? [],
			}
		default:
			return null
	}
}

let forward = function forward(sim: Sim, serverMessage: unknown): void {
	sim.transportEvents.push({ type: 'transport.message', message: { serverMessage } as never })
}

let onReaderOutput = function onReaderOutput(sim: Sim, output: ReaderOutput): void {
	switch (output.type) {
		case 'reader.messages':
			for (let group of output.groups) {
				// A force-stopped session is dead server-side the instant the stop is issued
				// and the model never forwards data for it afterwards — so any message
				// surfacing under that session id can only be a client-side buffering bug.
				if (sim.forceStopped.has(group.session.partitionSessionId)) {
					throw new Error(
						`messages emitted for force-stopped session ${group.session.partitionSessionId}`
					)
				}
				let key = partitionKey(group.session.topicPath, group.session.partitionId)
				let mirror = sim.mirrors.get(key)
				if (!mirror) {
					throw new Error(`messages delivered for never-started partition ${key}`)
				}
				for (let message of group.messages) {
					// D2 stitching: the commit range continues exactly at the delivery
					// watermark (or the message's own offset when it sits below it — a
					// redelivery raced past by concurrent commit acks).
					let expected =
						message.offset < mirror.nextStitch ? message.offset : mirror.nextStitch
					if (message.commitRangeStart !== expected) {
						throw new Error(
							`stitch break on ${key}: offset ${message.offset} carries commitRangeStart ${message.commitRangeStart}, expected ${expected}`
						)
					}
					mirror.msgs.push({
						start: message.commitRangeStart,
						end: message.offset + 1n,
						requested: false,
					})
					if (mirror.nextStitch < message.offset + 1n) {
						mirror.nextStitch = message.offset + 1n
					}
				}
			}
			sim.unreleased.push(output.releaseBytes)
			break
		case 'reader.partition.started': {
			// A fresh grant restarts redelivery (and thus stitching) at the server's
			// committed offset — the consumer-side view resets with it.
			let key = partitionKey(output.session.topicPath, output.partitionId)
			sim.mirrors.set(key, { nextStitch: output.committedOffset, msgs: [] })
			sim.gracefulTimeoutFired.delete(key)
			break
		}
		case 'reader.partition.committed': {
			let key = partitionKey(output.session.topicPath, output.partitionId)
			let prev = sim.committedSeen.get(key) ?? 0n
			if (output.committedOffset < prev) {
				throw new Error(
					`committed regressed on ${key}: ${prev} -> ${output.committedOffset}`
				)
			}
			sim.committedSeen.set(key, output.committedOffset)
			// The delivery watermark never falls below the committed offset — commits
			// re-applied on a fresh session can outrun redelivery.
			let mirror = sim.mirrors.get(key)
			if (mirror && mirror.nextStitch < output.committedOffset) {
				mirror.nextStitch = output.committedOffset
			}
			break
		}
		case 'reader.commit.resolved': {
			let waiter = sim.waiters.get(output.waiterId)
			if (waiter) {
				if (waiter.state === 'rejected') {
					throw new Error(`waiter ${output.waiterId} resolved after being rejected`)
				}
				waiter.state = 'resolved'
				// No-loss: claimed wire coverage is not an acknowledgment. A commit resolves
				// only after the server-reported watermark reaches its target.
				let part = sim.byKey.get(waiter.partitionKey)!
				if (waiter.endOffset > part.durableCommitted) {
					let entry = sim.readerCtx.partitions.get(waiter.partitionKey)
					let reportedCommitted = entry?.partitionCommittedOffset ?? 0n
					if (waiter.endOffset > reportedCommitted) {
						throw new Error(
							`commit resolved before a reported watermark: end=${waiter.endOffset} ` +
								`durable=${part.durableCommitted} reported=${reportedCommitted}`
						)
					}
				}
			}
			break
		}
		case 'reader.commit.rejected': {
			let waiter = sim.waiters.get(output.waiterId)
			if (waiter) {
				if (waiter.state === 'resolved') {
					throw new Error(`waiter ${output.waiterId} rejected after being resolved`)
				}
				waiter.state = 'rejected'
				waiter.rejectReason = output.reason
			}
			break
		}
		case 'reader.closed':
			sim.terminal = true
			break
	}
}

let applyReaderEffect = function applyReaderEffect(sim: Sim, effect: ReaderEffect): void {
	switch (effect.type) {
		case 'reader.effect.transport.connect':
			sim.transportEvents.push({ type: 'transport.connect' })
			break
		case 'reader.effect.send.read_request': {
			if (!sim.streamOpen || sim.initPending) break // lost on a not-yet-live stream
			sim.credit += effect.bytesSize
			break
		}
		case 'reader.effect.send.partition_status': {
			if (!sim.streamOpen || sim.initPending) break
			let part = sim.partitions.find(
				(p) => p.partitionSessionId === effect.partitionSessionId
			)
			if (part) {
				forward(sim, {
					case: 'partitionSessionStatusResponse',
					value: {
						partitionSessionId: effect.partitionSessionId,
						committedOffset: part.durableCommitted,
					},
				})
			}
			break
		}
		case 'reader.effect.send.commit': {
			if (!sim.streamOpen || sim.initPending) break
			let part = sim.partitions.find(
				(p) => p.partitionSessionId === effect.partitionSessionId
			)
			if (!part) {
				// The FSM's live-session guard failed: this frame names a session the
				// current stream never granted — session-fatal on a real server.
				throw new Error(
					`commit sent for a session the current stream never granted: ${effect.partitionSessionId}`
				)
			}
			// Wire contract: normalized ranges, nothing below the committed watermark,
			// nothing overlapping ranges this session already committed (both are
			// BAD_REQUEST "double committing is forbidden"), and nothing outside what
			// commit() calls actually asked for — a range covering a foreign
			// delivered-but-uncommitted message would commit someone else's data.
			assertNormalized(effect.ranges, `commit on ${part.key}`)
			for (let range of effect.ranges) {
				if (range.start < part.durableCommitted) {
					throw new Error(
						`commit on ${part.key} rewinds below committed: [${range.start}, ${range.end}) < ${part.durableCommitted}`
					)
				}
				if (overlapsAny(range, part.sessionRanges)) {
					throw new Error(
						`commit on ${part.key} overlaps an already-committed range: [${range.start}, ${range.end})`
					)
				}
			}
			if (!coveredBy(effect.ranges, sim.requestedUnion.get(part.key) ?? [])) {
				throw new Error(`commit on ${part.key} covers offsets no commit() ever asked for`)
			}
			// Apply at receive (wire order): the watermark advances over the contiguous
			// prefix; sparse remainders wait as session state.
			part.sessionRanges = modelMerge([...part.sessionRanges, ...effect.ranges])
			while (
				part.sessionRanges.length > 0 &&
				part.sessionRanges[0]!.start === part.durableCommitted
			) {
				part.durableCommitted = part.sessionRanges.shift()!.end
			}
			part.unackedCommits += 1
			break
		}
		case 'reader.effect.send.stop_response': {
			// Protocol: releasing the same partition session twice is session-fatal
			// (BAD_REQUEST), so the FSM must never emit a second one — count every
			// emission, wire-reachable or not.
			if (sim.stopResponded.has(effect.partitionSessionId)) {
				throw new Error(`duplicate stop_response for session ${effect.partitionSessionId}`)
			}
			sim.stopResponded.add(effect.partitionSessionId)
			if (!sim.streamOpen || sim.initPending) break
			let part = sim.partitions.find(
				(p) => p.partitionSessionId === effect.partitionSessionId
			)
			if (!part) break
			if (!part.stopping) {
				throw new Error(
					`unsolicited stop_response for session ${effect.partitionSessionId}`
				)
			}
			// D3: a graceful stop is answered only after BOTH the stop hook completed
			// (stop_ready) and the pending commits drained — or the per-partition
			// timeout escalated a stalled handshake.
			let entry = sim.readerCtx.partitions.get(part.key)
			let handshakeDone =
				entry !== undefined &&
				sim.stopReadyDone.has(entry.session) &&
				entry.commitWaiters.length === 0
			if (!handshakeDone && !sim.gracefulTimeoutFired.has(part.key)) {
				throw new Error(
					`stop_response for ${part.key} before stop_ready and drained commits`
				)
			}
			sim.gracefulTimeoutFired.delete(part.key)
			// The session is released. Commits the client sent before this response were
			// processed by the server first (wire order) and already advanced the durable
			// watermark; the sparse session state dies with the session — the client only
			// learns the watermark via a re-grant's committed_offset, which is exactly
			// what the reconcile must absorb.
			part.sessionRanges = []
			part.unackedCommits = 0
			part.partitionSessionId = undefined
			part.ready = false
			part.stopping = false
			break
		}
		case 'reader.effect.partition.start_hook': {
			// Mirror the hookless runtime: the async start handshake completes
			// immediately and re-enters the FSM as start_ready, which answers with
			// start_response and re-sends reconciled commits.
			sim.readerEvents.push({
				type: 'reader.partition.start_ready',
				session: effect.session,
			})
			break
		}
		case 'reader.effect.partition.stop_hook': {
			// The graceful-stop hook runs detached in the runtime — the model completes
			// it as a separate, randomly interleaved action (or in the cooldown flush).
			sim.pendingStopHooks.push(effect.session)
			break
		}
		case 'reader.effect.send.start_response': {
			if (!sim.streamOpen || sim.initPending) break
			let part = sim.partitions.find(
				(p) => p.partitionSessionId === effect.partitionSessionId
			)
			if (part) {
				part.ready = true
			}
			break
		}
		case 'reader.effect.send.update_token':
			break
		case 'reader.effect.timer.schedule': {
			let key =
				'partitionKey' in effect ? `${effect.which}:${effect.partitionKey}` : effect.which
			if (effect.which === 'recovery_window' && sim.armed.has(key)) {
				break
			}
			sim.armed.add(key)
			break
		}
		case 'reader.effect.timer.clear': {
			let key =
				'partitionKey' in effect ? `${effect.which}:${effect.partitionKey}` : effect.which
			sim.armed.delete(key)
			break
		}
		case 'reader.effect.finalize':
			sim.armed.clear()
			sim.transportEvents.push({ type: 'transport.destroy', reason: effect.reason })
			break
	}
}

let processReaderEvent = function processReaderEvent(sim: Sim, event: ReaderEvent): void {
	let runtime = {
		state: sim.readerState,
		signal: NEVER,
		emit: (output: ReaderOutput) => onReaderOutput(sim, output),
		dispatch: (next: ReaderEvent) => sim.readerEvents.push(next),
	}
	let result = readerTransition(sim.readerCtx, event, runtime)
	if (result?.state) {
		sim.readerState = result.state
	}
	for (let effect of result?.effects ?? []) {
		applyReaderEffect(sim, effect)
	}
}

// Stream replacement drops ephemeral assignments and sparse commit coverage;
// only the server's durable watermark survives. Production transport is tested separately.
let processTransportEvent = function processTransportEvent(sim: Sim, event: TransportEvent): void {
	switch (event.type) {
		case 'transport.connect':
			if (sim.terminal) {
				return
			}
			sim.streamOpen = true
			sim.initPending = true
			sim.credit = 0n
			for (let part of sim.partitions) {
				part.partitionSessionId = undefined
				part.ready = false
				part.stopping = false
				part.deliveredUpTo = part.durableCommitted
				part.sessionRanges = []
				part.unackedCommits = 0
			}
			return
		case 'transport.destroy':
			sim.streamOpen = false
			sim.initPending = false
			return
	}
	if (!sim.streamOpen || sim.terminal) {
		return
	}
	switch (event.type) {
		case 'transport.init':
			sim.initPending = false
			sim.readerEvents.push({
				type: 'reader.stream.init_response',
				sessionId: event.sessionId,
			})
			return
		case 'transport.message': {
			let mapped = classify(event.message)
			if (mapped) {
				sim.readerEvents.push(mapped)
			}
			return
		}
		case 'transport.ended':
		case 'transport.error':
			sim.streamOpen = false
			sim.initPending = false
			sim.readerEvents.push({
				type: 'reader.stream.disconnected',
				...('error' in event ? { error: event.error } : {}),
			})
	}
}

let runToQuiescence = function runToQuiescence(sim: Sim): void {
	let guard = 0
	while (sim.readerEvents.length > 0 || sim.transportEvents.length > 0) {
		if (++guard > 200_000) {
			throw new Error('livelock: quiescence never reached')
		}
		if (sim.readerEvents.length > 0) {
			processReaderEvent(sim, sim.readerEvents.shift()!)
		} else {
			processTransportEvent(sim, sim.transportEvents.shift()!)
		}
	}
}

// ── server / consumer actions ────────────────────────────────────────────────────

let sendInit = function sendInit(sim: Sim): void {
	sim.initPending = false
	sim.sessionCounter += 1
	sim.transportEvents.push({ type: 'transport.init', sessionId: `s${sim.sessionCounter}` })
}

let assignPartition = function assignPartition(sim: Sim, part: ServerPartition): void {
	let partitionSessionId = sim.nextSessionId++
	part.partitionSessionId = partitionSessionId
	part.ready = false
	part.stopping = false
	part.deliveredUpTo = part.durableCommitted
	part.sessionRanges = []
	part.unackedCommits = 0
	forward(sim, {
		case: 'startPartitionSessionRequest',
		value: {
			partitionSession: {
				partitionSessionId,
				partitionId: part.partitionId,
				path: part.path,
			},
			committedOffset: part.durableCommitted,
			partitionOffsets: { start: part.durableCommitted, end: part.availableUpTo },
		},
	})
}

let deliver = function deliver(
	sim: Sim,
	part: ServerPartition,
	randInt: (n: number) => number
): void {
	// A partition being handed off (graceful stop pending) gets no new data — the
	// server only keeps acking commits until the client answers the stop.
	if (part.partitionSessionId === undefined || !part.ready || part.stopping || sim.credit <= 0n) {
		return
	}
	if (part.deliveredUpTo >= part.availableUpTo) {
		return
	}
	let count = BigInt(1 + randInt(3))
	let end = part.deliveredUpTo + count
	if (end > part.availableUpTo) {
		end = part.availableUpTo
	}
	let offsets: bigint[] = []
	for (let o = part.deliveredUpTo; o < end; o++) {
		// Server-side offset holes (retention, compaction): the offset exists in the
		// numbering but is never delivered — the stitching must cover it via the NEXT
		// delivered message's commit range.
		if (randInt(5) === 0) {
			continue
		}
		offsets.push(o)
	}
	part.deliveredUpTo = end
	if (offsets.length === 0) {
		return
	}
	let bytesSize = BigInt(offsets.length * 10)
	sim.credit -= bytesSize
	forward(sim, {
		case: 'readResponse',
		value: {
			partitionData: [
				{
					partitionSessionId: part.partitionSessionId,
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
		},
	})
}

let ackCommits = function ackCommits(sim: Sim, part: ServerPartition): void {
	if (part.partitionSessionId === undefined || part.unackedCommits === 0) {
		return
	}
	part.unackedCommits = 0
	forward(sim, {
		case: 'commitOffsetResponse',
		value: {
			partitionsCommittedOffsets: [
				{
					partitionSessionId: part.partitionSessionId,
					committedOffset: part.durableCommitted,
				},
			],
		},
	})
}

// Consumer commit(): mirror the facade — merged half-open ranges built from the
// selected messages' stitched [commitRangeStart, offset+1), one waiter per call.
let issueCommit = function issueCommit(sim: Sim, key: string, selected: MirrorMessage[]): void {
	if (selected.length === 0) {
		return
	}
	for (let message of selected) {
		message.requested = true
	}
	let ranges = modelMerge(selected.map((m) => ({ start: m.start, end: m.end })))
	sim.requestedUnion.set(key, modelMerge([...(sim.requestedUnion.get(key) ?? []), ...ranges]))
	let waiterId = sim.nextWaiterId++
	sim.waiters.set(waiterId, {
		partitionKey: key,
		ranges,
		endOffset: ranges[ranges.length - 1]!.end,
		state: 'pending',
	})
	sim.readerEvents.push({ type: 'reader.commit', partitionKey: key, ranges, waiterId })
}

// ── invariants ────────────────────────────────────────────────────────────────

// Two non-terminal paths may reject a commit: the reassign gc (partition rebalanced
// away, held offsets never acknowledged) and the stop race (commit dispatched while
// the session was live but processed after the partition stopped — uncovered offsets
// can never be acked on this stream).
let isReassignRejection = function isReassignRejection(reason: unknown): boolean {
	return (
		reason instanceof Error &&
		(reason.message.includes('reassigned before commit') ||
			reason.message.includes('stopped or expired partition session'))
	)
}

let checkInvariants = function checkInvariants(sim: Sim, where: string): void {
	let ctx = sim.readerCtx

	if (sim.terminal) {
		if (sim.armed.size !== 0 || sim.streamOpen) {
			throw new Error(`${where}: terminal but timers or transport remain live`)
		}
		if (ctx.partitions.size !== 0 || ctx.sessionIndex.size !== 0) {
			throw new Error(`${where}: terminal but ctx not cleared`)
		}
		for (let waiter of sim.waiters.values()) {
			if (waiter.state === 'pending') {
				throw new Error(`${where}: terminal but a waiter is still pending (leak)`)
			}
		}
		return
	}

	// Non-terminal: a rejection must carry the reassign-gc reason. Terminal-shutdown
	// rejections never reach here — the reader.closed that follows them flips
	// sim.terminal before invariants run.
	for (let [id, waiter] of sim.waiters) {
		if (waiter.state === 'rejected' && !isReassignRejection(waiter.rejectReason)) {
			throw new Error(
				`${where}: commit ${id} rejected for an illegal reason: ${waiter.rejectReason}`
			)
		}
	}

	let retainedBytes = sim.unreleased.reduce((total, bytes) => total + bytes, 0n)
	if (ctx.bufferedBytes !== retainedBytes) {
		throw new Error(
			`${where}: retained flow-control bytes ${ctx.bufferedBytes} differ from queued ${retainedBytes}`
		)
	}

	if (sim.readerState === 'ready') {
		let expectedCredit = ctx.limits.maxBufferBytes - retainedBytes
		if (sim.credit !== expectedCredit) {
			throw new Error(`${where}: expected server credit ${expectedCredit}, got ${sim.credit}`)
		}
	}

	if (sim.readerState === 'waiting-credit') {
		if (sim.credit !== 0n || retainedBytes < ctx.limits.maxBufferBytes) {
			throw new Error(
				`${where}: initialized session waits for credit without a full retained buffer`
			)
		}
	}

	// sessionIndex is consistent: every entry points to a partition whose current
	// partitionSessionId equals the index key.
	for (let [partitionSessionId, key] of ctx.sessionIndex) {
		let entry = ctx.partitions.get(key)
		if (!entry) {
			throw new Error(
				`${where}: sessionIndex ${partitionSessionId} -> missing partition ${key}`
			)
		}
		if (entry.session.partitionSessionId !== partitionSessionId) {
			throw new Error(
				`${where}: stale sessionIndex ${partitionSessionId} -> ${key} (current ${entry.session.partitionSessionId})`
			)
		}
	}

	for (let [key, entry] of ctx.partitions) {
		if (entry.deliveredWatermark < entry.partitionCommittedOffset) {
			throw new Error(`${where}: delivery watermark below committed on ${key}`)
		}
		for (let pending of entry.commitWaiters) {
			if (pending.targetOffset <= entry.partitionCommittedOffset) {
				throw new Error(`${where}: confirmed pending target on ${key}`)
			}
		}
		// Compare against the consumer's original requests, independently of how the
		// implementation batches their coverage or deduplicates concurrent callers.
		let requests = Array.from(sim.waiters.values())
			.filter((waiter) => waiter.partitionKey === key && waiter.state === 'pending')
			.flatMap((waiter) => waiter.ranges)
		let expected = clampRanges(modelMerge(requests), entry.partitionCommittedOffset)
		assertNormalized(entry.pendingRanges, `${where}: pending ranges on ${key}`)
		if (!sameRanges(entry.pendingRanges, expected)) {
			throw new Error(`${where}: pending ranges differ from consumer requests on ${key}`)
		}
		// The model's independently tracked delivery watermark agrees with the FSM's.
		let mirror = sim.mirrors.get(key)
		if (mirror && mirror.nextStitch !== entry.deliveredWatermark) {
			throw new Error(
				`${where}: stitch watermark drift on ${key}: model ${mirror.nextStitch} != fsm ${entry.deliveredWatermark}`
			)
		}
	}
}

// A run that never went terminal: after the cooldown drove a full drain and fired
// every stall-bounding timer, a waiter's fate is decided — none may still be pending
// (hang), and rejection is legal only with the reassign-gc reason.
let checkFinal = function checkFinal(sim: Sim, seed: number): void {
	if (sim.terminal) {
		return
	}
	for (let [id, waiter] of sim.waiters) {
		if (waiter.state === 'rejected' && !isReassignRejection(waiter.rejectReason)) {
			throw new Error(`seed=${seed}: commit ${id} rejected without a legal reason`)
		}
		if (waiter.state === 'pending') {
			throw new Error(`seed=${seed}: commit ${id} never settled after cooldown (hang)`)
		}
	}
}

// ── driver ──────────────────────────────────────────────────────────────────────

let runOne = function runOne(
	seed: number,
	topology: { path: string; partitionId: bigint }[],
	steps: number
): void {
	let rng = mulberry32(seed)
	let randInt = (bound: number): number => Math.floor(rng() * bound)

	let sim = mkSim(topology, 1000n)

	sim.readerEvents.push({ type: 'reader.start' })
	runToQuiescence(sim)
	checkInvariants(sim, `seed=${seed} start`)

	for (let step = 0; step < steps && !sim.terminal; step++) {
		// Keep new data flowing so there is always something to read/commit.
		for (let part of sim.partitions) {
			if (randInt(3) === 0) {
				part.availableUpTo += BigInt(1 + randInt(3))
			}
		}

		let live =
			sim.readerState === 'connecting' ||
			sim.readerState === 'ready' ||
			sim.readerState === 'waiting-credit' ||
			sim.readerState === 'reconnecting'

		let actions: Array<{ w: number; run: () => void }> = []

		// Consumer: release a buffered chunk's credit.
		if (sim.unreleased.length > 0) {
			actions.push({
				w: 6,
				run: () => {
					let bytes = sim.unreleased.shift()!
					sim.readerEvents.push({ type: 'reader.read_release', bytes })
				},
			})
		}

		// Consumer: commit delivered messages the way the facade does — per-message
		// stitched ranges, merged. Mixed selection shapes: the oldest unrequested run,
		// a skip-ahead (sparse hole the watermark cannot pass yet), a non-contiguous
		// subset (several wire ranges), and an overlap with an earlier commit().
		if (live) {
			for (let [key, mirror] of sim.mirrors) {
				if (!sim.readerCtx.partitions.has(key)) {
					continue
				}
				if (!mirror.msgs.some((m) => !m.requested)) {
					continue
				}
				actions.push({
					w: 5,
					run: () => {
						let fresh = mirror.msgs.filter((m) => !m.requested)
						if (fresh.length === 0) {
							return
						}
						let mode = randInt(6)
						let selected: MirrorMessage[]
						if (mode === 0) {
							// Non-contiguous picks merge into SEVERAL wire ranges (a consumer
							// acking messages out of order after parallel processing).
							selected = fresh.filter(() => randInt(2) === 0)
							if (selected.length === 0) {
								selected = [fresh[0]!]
							}
						} else if (mode === 1) {
							// Overlap a previous commit(): re-committed offsets are claimed
							// or durable — the FSM must dedupe them off the wire, never resend.
							let from = randInt(mirror.msgs.length)
							selected = mirror.msgs.slice(from, from + 1 + randInt(3))
						} else if (mode === 2 && fresh.length > 1) {
							// Skip ahead: leaves a hole the watermark cannot pass until the
							// earlier messages are committed too.
							let from = randInt(fresh.length)
							selected = fresh.slice(from, from + 1 + randInt(3))
						} else {
							selected = fresh.slice(0, 1 + randInt(3))
						}
						issueCommit(sim, key, selected)
					},
				})
			}
		}

		// Low weight: most runs must SURVIVE to the reconcile teeth and cooldown —
		// terminal shutdown is a coverage path, not the default outcome.
		if (live) {
			actions.push({ w: 0.1, run: () => sim.readerEvents.push({ type: 'reader.close' }) })
			actions.push({
				w: 0.1,
				run: () => {
					sim.readerEvents.push({ type: 'reader.destroy', reason: new Error('destroy') })
				},
			})
		}

		// The async stop hook completes — possibly long after the stop request, and in
		// any order relative to the commit drain (the FSM must wait for BOTH).
		for (let i = 0; i < sim.pendingStopHooks.length; i++) {
			actions.push({
				w: 4,
				run: () => {
					let hook = sim.pendingStopHooks.splice(i, 1)[0]!
					sim.stopReadyDone.add(hook)
					sim.readerEvents.push({
						type: 'reader.partition.stop_ready',
						session: hook,
					})
				},
			})
		}

		// Server: init a pending stream.
		if (sim.streamOpen && sim.initPending) {
			actions.push({ w: 8, run: () => sendInit(sim) })
		}

		if (sim.streamOpen && !sim.initPending) {
			for (let part of sim.partitions) {
				if (part.partitionSessionId === undefined) {
					actions.push({ w: 5, run: () => assignPartition(sim, part) })
				} else {
					actions.push({ w: 6, run: () => deliver(sim, part, randInt) })
					if (part.unackedCommits > 0) {
						actions.push({ w: 6, run: () => ackCommits(sim, part) })
					}
					// Server-initiated graceful hand-off: delivery stops (deliver guards on
					// stopping), commits keep getting acked, and the session is released only
					// by the client's stop_response (or the partition_graceful_timeout forcing one).
					if (part.ready && !part.stopping) {
						actions.push({
							w: 2,
							run: () => {
								part.stopping = true
								forward(sim, {
									case: 'stopPartitionSessionRequest',
									value: {
										partitionSessionId: part.partitionSessionId,
										graceful: true,
										committedOffset: part.durableCommitted,
									},
								})
							},
						})
					}
					// Force stop (also as an escalation of a pending graceful stop): the
					// partition is seized immediately, no response expected, and un-acked
					// commits die with the session — the client must recover them through a
					// re-grant reconcile or reject them via the reassign gc.
					actions.push({
						w: 1,
						run: () => {
							sim.forceStopped.add(part.partitionSessionId!)
							forward(sim, {
								case: 'stopPartitionSessionRequest',
								value: {
									partitionSessionId: part.partitionSessionId,
									graceful: false,
									committedOffset: part.durableCommitted,
								},
							})
							part.partitionSessionId = undefined
							part.ready = false
							part.stopping = false
							part.sessionRanges = []
							part.unackedCommits = 0
						},
					})
				}
			}
			// Network faults.
			actions.push({ w: 2, run: () => sim.transportEvents.push({ type: 'transport.ended' }) })
			actions.push({
				w: 2,
				run: () =>
					sim.transportEvents.push({
						type: 'transport.error',
						error: new YDBError(StatusIds_StatusCode.UNAVAILABLE, []),
					}),
			})
		}

		// Timer firings. All timers are one-shot in the runtime except the repeating
		// update_token interval.
		for (let key of sim.armed) {
			let sep = key.indexOf(':')
			let which = sep === -1 ? key : key.slice(0, sep)
			let pkey = sep === -1 ? undefined : key.slice(sep + 1)
			actions.push({
				w: which === 'update_token' ? 1 : 3,
				run: () => {
					if (which !== 'update_token') {
						sim.armed.delete(key)
					}
					if (which === 'partition_reassign_gc') {
						sim.readerEvents.push({
							type: 'reader.timer.partition_reassign_gc',
							partitionKey: pkey!,
						})
					} else if (which === 'partition_graceful_timeout') {
						// Per-partition stall fallback — distinct from the key-less close
						// deadline the FSM honors only in `closing`. Firing it legalizes a
						// stop_response with the handshake still incomplete.
						sim.gracefulTimeoutFired.add(pkey!)
						sim.readerEvents.push({
							type: 'reader.timer.partition_graceful_timeout',
							partitionKey: pkey!,
						})
					} else {
						sim.readerEvents.push({ type: `reader.timer.${which}` } as ReaderEvent)
					}
				},
			})
		}

		if (actions.length === 0) {
			break
		}

		let total = actions.reduce((s, a) => s + a.w, 0)
		let r = rng() * total
		let chosen = actions[actions.length - 1]!
		for (let a of actions) {
			r -= a.w
			if (r < 0) {
				chosen = a
				break
			}
		}
		chosen.run()
		runToQuiescence(sim)
		checkInvariants(sim, `seed=${seed} step=${step}`)
	}

	// Teeth for reconcile / commit-liveness: deliver fresh uncommitted data to each
	// live partition, commit it, then force a reconnect BEFORE the server acks. The
	// un-acked commit can only resolve if the reader re-sends it on the new session.
	if (!sim.terminal && sim.readerState === 'ready' && sim.streamOpen && !sim.initPending) {
		sim.credit += 100_000n
		for (let part of sim.partitions) {
			if (part.partitionSessionId !== undefined && part.ready && !part.stopping) {
				part.availableUpTo = part.deliveredUpTo + 5n
				deliver(sim, part, () => 4)
			}
		}
		runToQuiescence(sim)
		for (let [key, mirror] of sim.mirrors) {
			if (!sim.readerCtx.partitions.has(key)) {
				continue
			}
			issueCommit(
				sim,
				key,
				mirror.msgs.filter((m) => !m.requested)
			)
		}
		runToQuiescence(sim)
		if (sim.streamOpen) {
			sim.transportEvents.push({ type: 'transport.ended' })
			runToQuiescence(sim)
		}
	}

	// Cooldown: reconnect + init, re-grant every partition, redeliver, complete the
	// outstanding stop hooks, commit everything still unrequested (filling any sparse
	// holes so the watermark can pass), and drain acks until a fixed point.
	for (let i = 0; i < 5000 && !sim.terminal; i++) {
		if (!sim.streamOpen) {
			if (sim.armed.has('retry_backoff')) {
				sim.armed.delete('retry_backoff')
				sim.readerEvents.push({ type: 'reader.timer.retry_backoff' })
			} else if (sim.armed.has('start_timeout')) {
				sim.armed.delete('start_timeout')
				sim.readerEvents.push({ type: 'reader.timer.start_timeout' })
			} else if (sim.armed.has('graceful_timeout')) {
				// close() was called while no stream was up: the connect timers are
				// cleared, so only the key-less close deadline can settle the drain.
				sim.armed.delete('graceful_timeout')
				sim.readerEvents.push({ type: 'reader.timer.graceful_timeout' })
			} else {
				break
			}
			runToQuiescence(sim)
			continue
		}
		if (sim.initPending) {
			sendInit(sim)
			runToQuiescence(sim)
			continue
		}

		while (sim.unreleased.length > 0) {
			sim.readerEvents.push({ type: 'reader.read_release', bytes: sim.unreleased.shift()! })
		}
		let progressed = false
		for (let part of sim.partitions) {
			if (part.partitionSessionId === undefined) {
				assignPartition(sim, part)
				progressed = true
			}
		}
		runToQuiescence(sim)
		for (let part of sim.partitions) {
			while (
				part.partitionSessionId !== undefined &&
				part.ready &&
				!part.stopping &&
				sim.credit > 0n &&
				part.deliveredUpTo < part.availableUpTo
			) {
				deliver(sim, part, randInt)
				progressed = true
			}
		}
		runToQuiescence(sim)
		while (sim.pendingStopHooks.length > 0) {
			let hook = sim.pendingStopHooks.shift()!
			sim.stopReadyDone.add(hook)
			sim.readerEvents.push({
				type: 'reader.partition.stop_ready',
				session: hook,
			})
			progressed = true
		}
		runToQuiescence(sim)
		if (sim.readerState === 'ready') {
			for (let [key, mirror] of sim.mirrors) {
				if (!sim.readerCtx.partitions.has(key)) {
					continue
				}
				let unrequested = mirror.msgs.filter((m) => !m.requested)
				if (unrequested.length > 0) {
					issueCommit(sim, key, unrequested)
					progressed = true
				}
			}
			runToQuiescence(sim)
		}
		for (let part of sim.partitions) {
			if (part.unackedCommits > 0) {
				ackCommits(sim, part)
				progressed = true
			}
		}
		runToQuiescence(sim)
		if (progressed) {
			continue
		}

		// Quiesced with no assignable/deliverable/ackable work left, yet waiters may
		// still be pending behind a stalled graceful stop or an orphaned partition.
		// Fire the stall-bounding timers the way the real runtime eventually would:
		// per-partition partition_graceful_timeout first (its stop_response frees the
		// partition for a re-grant, so the waiter can still RESOLVE), then the reassign
		// gc (a legal rejection), and last the key-less close deadline armed by toClosing.
		let fired = false
		for (let key of [...sim.armed]) {
			if (key.startsWith('partition_graceful_timeout:')) {
				sim.armed.delete(key)
				let pkey = key.slice('partition_graceful_timeout:'.length)
				sim.gracefulTimeoutFired.add(pkey)
				sim.readerEvents.push({
					type: 'reader.timer.partition_graceful_timeout',
					partitionKey: pkey,
				})
				fired = true
			}
		}
		if (!fired) {
			for (let key of [...sim.armed]) {
				if (key.startsWith('partition_reassign_gc:')) {
					sim.armed.delete(key)
					sim.readerEvents.push({
						type: 'reader.timer.partition_reassign_gc',
						partitionKey: key.slice('partition_reassign_gc:'.length),
					})
					fired = true
				}
			}
		}
		if (!fired && sim.armed.has('graceful_timeout')) {
			sim.armed.delete('graceful_timeout')
			sim.readerEvents.push({ type: 'reader.timer.graceful_timeout' })
			fired = true
		}
		if (!fired) {
			break
		}
		runToQuiescence(sim)
	}

	checkInvariants(sim, `seed=${seed} cooldown`)
	checkFinal(sim, seed)
}

test('random reader sequences preserve every invariant (single partition)', () => {
	let runs = 0
	for (let seed = 1; seed <= 400; seed++) {
		runOne(seed, [{ path: '/t', partitionId: 10n }], 60)
		runs++
	}
	expect(runs).toBe(400)
})

test('random reader sequences preserve every invariant (multi partition, colliding ids across topics)', () => {
	let runs = 0
	for (let seed = 1; seed <= 400; seed++) {
		// partitionId 10 exists in BOTH topics: only the composite (path, partitionId)
		// key tells the state apart — id-keyed state would cross-wire commits and grants.
		runOne(
			seed + 100_000,
			[
				{ path: '/a', partitionId: 10n },
				{ path: '/b', partitionId: 10n },
				{ path: '/b', partitionId: 11n },
			],
			60
		)
		runs++
	}
	expect(runs).toBe(400)
})
