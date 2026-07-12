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
	readerTransition,
} from './reader-state.ts'
import {
	type TransportEffect,
	type TransportEvent,
	type TransportOutput,
	type TransportState,
	transportTransition,
} from './transport-state.ts'

// Model-based / property test. It wires the two REAL pure transitions
// (readerTransition + transportTransition) to a protocol-faithful server model and
// drives them with random sequences of consumer calls, commits, network events,
// server assignments/deliveries/acks, server-initiated partition stops (graceful
// AND force) and timer firings — including the per-partition partition_graceful_timeout and
// partition_reassign_gc — checking invariants after every step. The crux is
// commit-reconcile across reconnect and partition churn: a commit must never be
// rejected by a transparent reconnect, a resolved commit must be durable on the
// server, a stop_response is sent at most once per partition session, no data may
// surface for a force-stopped session, and after the cooldown every waiter must
// have settled. The only legal rejections are the reassign gc (partition rebalanced
// away before its commits were acknowledged) and a terminal shutdown — any other
// rejection is a bug.

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

type ServerPartition = {
	partitionId: bigint
	durableCommitted: bigint // persisted, survives reconnect
	availableUpTo: bigint // server holds messages [0, availableUpTo)
	deliveredUpTo: bigint // delivered on the current stream
	partitionSessionId: bigint | undefined // ephemeral id, set on assign, cleared on stop/reconnect
	ready: boolean // client sent StartPartitionSessionResponse
	stopping: boolean // graceful stop pending the client's response
	pendingCommitEnds: bigint[] // commit range ends the client sent, not yet acked
}

type Waiter = {
	partitionId: bigint
	endOffset: bigint
	state: 'pending' | 'resolved' | 'rejected'
	rejectReason?: unknown
}

type Sim = {
	readerState: ReaderState
	readerCtx: ReaderCtx
	transportState: TransportState
	readerEvents: ReaderEvent[]
	transportEvents: TransportEvent[]

	armed: Set<string> // timer keys

	streamOpen: boolean
	initPending: boolean
	credit: bigint // server flow-control: sum(ReadRequest.bytesSize) - sum(ReadResponse.bytesSize)
	nextSessionId: bigint
	sessionCounter: number

	partitions: ServerPartition[]
	waiters: Map<number, Waiter>
	unreleased: bigint[] // reader.messages releaseBytes emitted, not yet released by the consumer

	// Session ids are globally unique here (nextSessionId is monotonic), so both sets
	// can track per-session facts across streams without collisions.
	stopResponded: Set<bigint> // sessions already released via stop_response (a duplicate is session-fatal)
	forceStopped: Set<bigint> // sessions killed by a force stop — no reader.messages may follow

	committedSeen: Map<bigint, bigint> // partitionId -> last partitionCommittedOffset (monotonic check)
	errored: boolean
	destroyed: boolean
	terminal: boolean
}

let mkSim = function mkSim(partitionCount: number, maxBufferBytes: bigint): Sim {
	let partitions: ServerPartition[] = []
	for (let i = 0; i < partitionCount; i++) {
		partitions.push({
			partitionId: BigInt(10 + i),
			durableCommitted: 0n,
			availableUpTo: 0n,
			deliveredUpTo: 0n,
			partitionSessionId: undefined,
			ready: false,
			stopping: false,
			pendingCommitEnds: [],
		})
	}
	return {
		readerState: 'idle',
		readerCtx: createReaderCtx({ maxBufferBytes }),
		transportState: 'idle',
		readerEvents: [],
		transportEvents: [],
		armed: new Set(),
		streamOpen: false,
		initPending: false,
		credit: 0n,
		nextSessionId: 1n,
		sessionCounter: 0,
		partitions,
		waiters: new Map(),
		unreleased: [],
		stopResponded: new Set(),
		forceStopped: new Set(),
		committedSeen: new Map(),
		errored: false,
		destroyed: false,
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
		case 'endPartitionSession':
			return {
				type: 'reader.stream.end_partition',
				partitionSessionId: server.value.partitionSessionId,
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
			// A force-stopped session is dead server-side the instant the stop is issued
			// and the model never forwards data for it afterwards — so any message
			// surfacing under that session id can only be a client-side buffering bug.
			for (let group of output.groups) {
				if (sim.forceStopped.has(group.session.partitionSessionId)) {
					throw new Error(
						`messages emitted for force-stopped session ${group.session.partitionSessionId}`
					)
				}
			}
			sim.unreleased.push(output.releaseBytes)
			break
		case 'reader.partition.committed': {
			let prev = sim.committedSeen.get(output.partitionId) ?? 0n
			if (output.committedOffset < prev) {
				throw new Error(
					`committed regressed on ${output.partitionId}: ${prev} -> ${output.committedOffset}`
				)
			}
			sim.committedSeen.set(output.partitionId, output.committedOffset)
			break
		}
		case 'reader.commit.resolved': {
			let waiter = sim.waiters.get(output.waiterId)
			if (waiter) {
				if (waiter.state === 'rejected') {
					throw new Error(`waiter ${output.waiterId} resolved after being rejected`)
				}
				waiter.state = 'resolved'
				// No-loss: a resolved commit must be durable on the server.
				let part = sim.partitions.find((p) => p.partitionId === waiter.partitionId)!
				if (waiter.endOffset > part.durableCommitted) {
					throw new Error(
						`commit resolved but not durable: end=${waiter.endOffset} durable=${part.durableCommitted}`
					)
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
		case 'reader.error':
			sim.errored = true
			break
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
		case 'reader.effect.send.commit': {
			if (!sim.streamOpen || sim.initPending) break
			let part = sim.partitions.find(
				(p) => p.partitionSessionId === effect.partitionSessionId
			)
			if (part) {
				for (let range of effect.ranges) {
					part.pendingCommitEnds.push(range.end)
				}
			}
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
			if (part) {
				// Wire order: commits the client sent before this response were processed
				// by the server first, so they are durably applied — just never acked (the
				// session is released). The client only learns of them via a re-grant's
				// committed_offset, which is exactly what the reconcile must absorb.
				part.durableCommitted = part.pendingCommitEnds.reduce(
					(m, e) => (e > m ? e : m),
					part.durableCommitted
				)
				part.pendingCommitEnds = []
				part.partitionSessionId = undefined
				part.ready = false
				part.stopping = false
			}
			break
		}
		case 'reader.effect.partition.start_hook': {
			// Mirror the runtime: the (hookless) async handshake completes immediately
			// and re-enters the FSM as start_ready, which answers with start_response
			// and re-sends reconciled commits.
			sim.readerEvents.push({
				type: 'reader.partition.start_ready',
				partitionSessionId: effect.partitionSessionId,
				partitionId: effect.partitionId,
				grantId: effect.grantId,
			})
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
		case 'reader.effect.transport.close':
			sim.transportEvents.push({ type: 'transport.close' })
			break
		case 'reader.effect.timer.schedule': {
			let key =
				'partitionId' in effect ? `${effect.which}:${effect.partitionId}` : effect.which
			if (effect.which === 'recovery_window' && sim.armed.has(key)) {
				break
			}
			sim.armed.add(key)
			break
		}
		case 'reader.effect.timer.clear': {
			let key =
				'partitionId' in effect ? `${effect.which}:${effect.partitionId}` : effect.which
			sim.armed.delete(key)
			break
		}
		case 'reader.effect.finalize':
			sim.armed.clear()
			sim.transportEvents.push({ type: 'transport.destroy', reason: effect.reason })
			break
	}
}

let applyTransportEffect = function applyTransportEffect(sim: Sim, effect: TransportEffect): void {
	switch (effect.type) {
		case 'transport.effect.open_stream':
			sim.streamOpen = true
			sim.initPending = true
			sim.credit = 0n
			// Ephemeral assignments die with the old stream.
			for (let part of sim.partitions) {
				part.partitionSessionId = undefined
				part.ready = false
				part.stopping = false
				part.deliveredUpTo = part.durableCommitted
				part.pendingCommitEnds = []
			}
			break
		case 'transport.effect.close_stream':
		case 'transport.effect.finalize':
			sim.streamOpen = false
			sim.initPending = false
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

let processTransportEvent = function processTransportEvent(sim: Sim, event: TransportEvent): void {
	let runtime = {
		state: sim.transportState,
		signal: NEVER,
		emit: (output: TransportOutput) => {
			let mapped: ReaderEvent | null =
				output.type === 'transport.stream.init_response'
					? { type: 'reader.stream.init_response', sessionId: output.sessionId }
					: output.type === 'transport.stream.disconnected'
						? {
								type: 'reader.stream.disconnected',
								...('error' in output ? { error: output.error } : {}),
							}
						: classify(output.message)
			if (mapped) {
				sim.readerEvents.push(mapped)
			}
		},
		dispatch: (next: TransportEvent) => sim.transportEvents.push(next),
	}
	let result = transportTransition({}, event, runtime)
	if (result?.state) {
		sim.transportState = result.state
	}
	for (let effect of result?.effects ?? []) {
		applyTransportEffect(sim, effect)
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
	forward(sim, {
		case: 'startPartitionSessionRequest',
		value: {
			partitionSession: {
				partitionSessionId,
				partitionId: part.partitionId,
				path: '/t',
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
		offsets.push(o)
	}
	let bytesSize = BigInt(offsets.length * 10)
	part.deliveredUpTo = end
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
	if (part.partitionSessionId === undefined || part.pendingCommitEnds.length === 0) {
		return
	}
	let maxEnd = part.pendingCommitEnds.reduce((m, e) => (e > m ? e : m), part.durableCommitted)
	part.durableCommitted = maxEnd
	part.pendingCommitEnds = []
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

// ── invariants ────────────────────────────────────────────────────────────────

// The reassign gc is the ONE non-terminal path allowed to reject a commit: the
// partition was rebalanced away and nothing can ever acknowledge those offsets.
let isReassignRejection = function isReassignRejection(reason: unknown): boolean {
	return reason instanceof Error && reason.message.includes('reassigned before commit')
}

let checkInvariants = function checkInvariants(sim: Sim, where: string): void {
	let ctx = sim.readerCtx

	if (sim.terminal) {
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

	if (ctx.inFlightBytes < 0n || ctx.pendingReadRequestBytes < 0n) {
		throw new Error(
			`${where}: negative flow-control inFlight=${ctx.inFlightBytes} pending=${ctx.pendingReadRequestBytes}`
		)
	}

	// sessionIndex is consistent: every entry points to a partition whose current
	// partitionSessionId equals the index key.
	for (let [partitionSessionId, partitionId] of ctx.sessionIndex) {
		let entry = ctx.partitions.get(partitionId)
		if (!entry) {
			throw new Error(
				`${where}: sessionIndex ${partitionSessionId} -> missing partition ${partitionId}`
			)
		}
		if (entry.partitionSessionId !== partitionSessionId) {
			throw new Error(
				`${where}: stale sessionIndex ${partitionSessionId} -> partition ${partitionId} (current ${entry.partitionSessionId})`
			)
		}
	}

	// pending commit ranges per partition are strictly increasing and non-overlapping.
	for (let entry of ctx.partitions.values()) {
		let prevEnd = -1n
		for (let pending of entry.pendingCommits) {
			if (pending.startOffset < prevEnd) {
				throw new Error(`${where}: overlapping pending commit on ${entry.partitionId}`)
			}
			if (pending.endOffset <= pending.startOffset) {
				throw new Error(`${where}: empty pending commit range on ${entry.partitionId}`)
			}
			prevEnd = pending.endOffset
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

let runOne = function runOne(seed: number, partitionCount: number, steps: number): void {
	let rng = mulberry32(seed)
	let randInt = (bound: number): number => Math.floor(rng() * bound)

	let sim = mkSim(partitionCount, 1000n)
	let nextWaiterId = 1

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

		// Consumer: commit some delivered-but-uncommitted offsets on a live partition.
		if (live) {
			for (let entry of sim.readerCtx.partitions.values()) {
				let part = sim.partitions.find((p) => p.partitionId === entry.partitionId)
				if (!part || part.deliveredUpTo <= entry.nextCommitStartOffset) {
					continue
				}
				actions.push({
					w: 5,
					run: () => {
						let upTo = part.deliveredUpTo - 1n
						let offsets: bigint[] = []
						for (let o = entry.nextCommitStartOffset; o <= upTo; o++) {
							offsets.push(o)
						}
						if (offsets.length === 0) {
							return
						}
						let waiterId = nextWaiterId++
						sim.waiters.set(waiterId, {
							partitionId: part.partitionId,
							endOffset: upTo + 1n,
							state: 'pending',
						})
						sim.readerEvents.push({
							type: 'reader.commit',
							partitionId: part.partitionId,
							offsets,
							waiterId,
						})
					},
				})
			}
		}

		if (live) {
			actions.push({ w: 1, run: () => sim.readerEvents.push({ type: 'reader.close' }) })
			actions.push({
				w: 1,
				run: () => {
					sim.destroyed = true
					sim.readerEvents.push({ type: 'reader.destroy', reason: new Error('destroy') })
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
					if (part.pendingCommitEnds.length > 0) {
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
							part.pendingCommitEnds = []
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

		// Timer firings.
		for (let key of sim.armed) {
			let which = key.split(':')[0]!
			let pid = key.split(':')[1]
			let oneShot =
				which === 'start_timeout' ||
				which === 'retry_backoff' ||
				which === 'recovery_window' ||
				which === 'graceful_timeout' ||
				which === 'partition_graceful_timeout'
			actions.push({
				w: which === 'update_token' ? 1 : 3,
				run: () => {
					if (oneShot) {
						sim.armed.delete(key)
					}
					if (which === 'partition_reassign_gc') {
						sim.readerEvents.push({
							type: 'reader.timer.partition_reassign_gc',
							partitionId: BigInt(pid!),
						})
					} else if (which === 'partition_graceful_timeout') {
						// Per-partition stall fallback — distinct from the pid-less close
						// deadline the FSM honors only in `closing`.
						sim.readerEvents.push({
							type: 'reader.timer.partition_graceful_timeout',
							partitionId: BigInt(pid!),
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
			if (part.partitionSessionId !== undefined && part.ready) {
				part.availableUpTo = part.deliveredUpTo + 5n
				deliver(sim, part, () => 4)
			}
		}
		runToQuiescence(sim)
		for (let entry of sim.readerCtx.partitions.values()) {
			let part = sim.partitions.find((p) => p.partitionId === entry.partitionId)
			if (!part || part.deliveredUpTo <= entry.nextCommitStartOffset) {
				continue
			}
			let upTo = part.deliveredUpTo - 1n
			let offsets: bigint[] = []
			for (let o = entry.nextCommitStartOffset; o <= upTo; o++) {
				offsets.push(o)
			}
			let waiterId = nextWaiterId++
			sim.waiters.set(waiterId, {
				partitionId: part.partitionId,
				endOffset: upTo + 1n,
				state: 'pending',
			})
			sim.readerEvents.push({
				type: 'reader.commit',
				partitionId: part.partitionId,
				offsets,
				waiterId,
			})
		}
		runToQuiescence(sim)
		if (sim.streamOpen) {
			sim.transportEvents.push({ type: 'transport.ended' })
			runToQuiescence(sim)
		}
	}

	// Cooldown: reconnect + init + drain acks so committed offsets settle.
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
				// cleared, so only the pid-less close deadline can settle the drain.
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
		let progressed = false
		for (let part of sim.partitions) {
			if (part.partitionSessionId === undefined) {
				assignPartition(sim, part)
				progressed = true
			} else if (part.pendingCommitEnds.length > 0) {
				ackCommits(sim, part)
				progressed = true
			}
		}
		runToQuiescence(sim)
		if (progressed) {
			continue
		}
		// Quiesced with no assignable/ackable work left, yet waiters may still be
		// pending behind a stalled graceful stop or an orphaned partition. Fire the
		// stall-bounding timers the way the real runtime eventually would: per-partition
		// partition_graceful_timeout first (its stop_response frees the partition for a
		// re-grant, so the waiter can still RESOLVE), then the reassign gc (a legal
		// rejection), and last the pid-less close deadline armed by toClosing.
		let fired = false
		for (let key of [...sim.armed]) {
			if (key.startsWith('partition_graceful_timeout:')) {
				sim.armed.delete(key)
				sim.readerEvents.push({
					type: 'reader.timer.partition_graceful_timeout',
					partitionId: BigInt(key.split(':')[1]!),
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
						partitionId: BigInt(key.split(':')[1]!),
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
		runOne(seed, 1, 60)
		runs++
	}
	expect(runs).toBe(400)
})

test('random reader sequences preserve every invariant (multi partition)', () => {
	let runs = 0
	for (let seed = 1; seed <= 400; seed++) {
		runOne(seed + 100_000, 3, 60)
		runs++
	}
	expect(runs).toBe(400)
})
