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
// server assignments/deliveries/acks and timer firings, checking invariants after
// every step. The crux is commit-reconcile across reconnect: a commit must never be
// rejected by a transparent reconnect, and a resolved commit must be durable on the
// server.
//
// This base run excludes force-stops, so the only legitimate commit rejection is a
// terminal shutdown — any other rejection is a bug.

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
	sessionId: bigint | undefined // ephemeral id, set on assign, cleared on stop/reconnect
	ready: boolean // client sent StartPartitionSessionResponse
	stopping: boolean // graceful stop pending the client's response
	pendingCommitEnds: bigint[] // commit range ends the client sent, not yet acked
}

type Waiter = { partitionId: bigint; endOffset: bigint; state: 'pending' | 'resolved' | 'rejected' }

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
			sessionId: undefined,
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
			sim.unreleased.push(output.releaseBytes)
			break
		case 'reader.committed': {
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
			let part = sim.partitions.find((p) => p.sessionId === effect.partitionSessionId)
			if (part) {
				for (let range of effect.ranges) {
					part.pendingCommitEnds.push(range.end)
				}
			}
			break
		}
		case 'reader.effect.send.stop_response': {
			if (!sim.streamOpen || sim.initPending) break
			let part = sim.partitions.find((p) => p.sessionId === effect.partitionSessionId)
			if (part) {
				part.sessionId = undefined
				part.ready = false
				part.stopping = false
			}
			break
		}
		case 'reader.effect.partition.start_ack': {
			// Model the async onPartitionSessionStart handshake as an immediate response.
			let part = sim.partitions.find((p) => p.sessionId === effect.partitionSessionId)
			if (part) {
				part.ready = true
			}
			break
		}
		case 'reader.effect.transport.send_update_token':
			break
		case 'reader.effect.transport.close':
			sim.transportEvents.push({ type: 'transport.close' })
			break
		case 'reader.effect.timer.schedule': {
			let key =
				effect.partitionId === undefined
					? effect.which
					: `${effect.which}:${effect.partitionId}`
			if (effect.which === 'recovery_window' && sim.armed.has(key)) {
				break
			}
			sim.armed.add(key)
			break
		}
		case 'reader.effect.timer.clear': {
			let key =
				effect.partitionId === undefined
					? effect.which
					: `${effect.which}:${effect.partitionId}`
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
				part.sessionId = undefined
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
	let sessionId = sim.nextSessionId++
	part.sessionId = sessionId
	part.ready = false
	part.stopping = false
	part.deliveredUpTo = part.durableCommitted
	forward(sim, {
		case: 'startPartitionSessionRequest',
		value: {
			partitionSession: {
				partitionSessionId: sessionId,
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
	if (part.sessionId === undefined || !part.ready || sim.credit <= 0n) {
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
					partitionSessionId: part.sessionId,
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
	if (part.sessionId === undefined || part.pendingCommitEnds.length === 0) {
		return
	}
	let maxEnd = part.pendingCommitEnds.reduce((m, e) => (e > m ? e : m), part.durableCommitted)
	part.durableCommitted = maxEnd
	part.pendingCommitEnds = []
	forward(sim, {
		case: 'commitOffsetResponse',
		value: {
			partitionsCommittedOffsets: [
				{ partitionSessionId: part.sessionId, committedOffset: part.durableCommitted },
			],
		},
	})
}

// ── invariants ────────────────────────────────────────────────────────────────

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

	if (ctx.inFlightBytes < 0n || ctx.pendingReadRequestBytes < 0n) {
		throw new Error(
			`${where}: negative flow-control inFlight=${ctx.inFlightBytes} pending=${ctx.pendingReadRequestBytes}`
		)
	}

	// sessionIndex is consistent: every entry points to a partition whose current
	// sessionId equals the index key.
	for (let [sessionId, partitionId] of ctx.sessionIndex) {
		let entry = ctx.partitions.get(partitionId)
		if (!entry) {
			throw new Error(
				`${where}: sessionIndex ${sessionId} -> missing partition ${partitionId}`
			)
		}
		if (entry.sessionId !== sessionId) {
			throw new Error(
				`${where}: stale sessionIndex ${sessionId} -> partition ${partitionId} (current ${entry.sessionId})`
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

// A run that never went terminal must never have rejected a commit (no reconnect can
// reject one, and this base run has no force-stops), and — after the cooldown drove a
// full drain — every commit must have resolved (no hang).
let checkFinal = function checkFinal(sim: Sim, seed: number): void {
	if (sim.terminal) {
		return
	}
	for (let [id, waiter] of sim.waiters) {
		if (waiter.state === 'rejected') {
			throw new Error(`seed=${seed}: commit ${id} rejected without a terminal shutdown`)
		}
		if (waiter.state === 'pending') {
			throw new Error(`seed=${seed}: commit ${id} never resolved after cooldown (hang)`)
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
				if (part.sessionId === undefined) {
					actions.push({ w: 5, run: () => assignPartition(sim, part) })
				} else {
					actions.push({ w: 6, run: () => deliver(sim, part, randInt) })
					if (part.pendingCommitEnds.length > 0) {
						actions.push({ w: 6, run: () => ackCommits(sim, part) })
					}
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
			let oneShot =
				which === 'start_timeout' ||
				which === 'retry_backoff' ||
				which === 'recovery_window' ||
				which === 'graceful_timeout'
			actions.push({
				w: which === 'update_token' ? 1 : 3,
				run: () => {
					if (oneShot) {
						sim.armed.delete(key)
					}
					if (which === 'partition_reassign_gc') {
						let partitionId = BigInt(key.split(':')[1]!)
						sim.readerEvents.push({
							type: 'reader.timer.partition_reassign_gc',
							partitionId,
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
			if (part.sessionId !== undefined && part.ready) {
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
			if (part.sessionId === undefined) {
				assignPartition(sim, part)
				progressed = true
			} else if (part.pendingCommitEnds.length > 0) {
				ackCommits(sim, part)
				progressed = true
			}
		}
		runToQuiescence(sim)
		if (!progressed) {
			break
		}
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
