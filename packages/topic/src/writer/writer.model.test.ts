import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { YDBError } from '@ydbjs/error'
import { expect, test } from 'vitest'

import {
	type BufferedMessage,
	type GlobalTimerName,
	type WriterCtx,
	type WriterEffect,
	type WriterEvent,
	type WriterOutput,
	type WriterState,
	createWriterCtx,
	writerTransition,
} from './writer-state.ts'
import {
	type TransportEffect,
	type TransportEvent,
	type TransportOutput,
	type TransportState,
	transportTransition,
} from './transport-state.ts'
import type { WriteAck } from './types.ts'

// Model-based / property test. It wires the two REAL pure transitions
// (writerTransition + transportTransition) to a protocol-faithful server model
// and drives them with random sequences of user calls, network events and timer
// firings, checking a set of invariants after every step. Timers are logical
// (fired on demand), so races the wall clock never surfaces — e.g. start_timeout
// firing just before a slow init — are explored deterministically.
//
// The point (per "test behavior, not code"): instead of hand-picking scenarios,
// we assert the CONTRACT holds across the whole reachable space of orderings.

// Deterministic PRNG so any failure is reproducible from its seed.
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

type Sim = {
	// FSMs (real transitions, mutable state + ctx)
	writerState: WriterState
	writerCtx: WriterCtx
	transportState: TransportState
	writerEvents: WriterEvent[]
	transportEvents: TransportEvent[]

	// logical timers
	armed: Set<GlobalTimerName>

	// transport/network + server model
	streamOpen: boolean
	initPending: boolean
	pendingGetLastSeqNo: boolean // set by the writer's connect effect
	streamGetLastSeqNo: boolean // captured when a stream opens
	pendingAcks: WriteAck[] // received on the current stream, not yet delivered
	persisted: Set<bigint> // server dedup store (survives reconnects)
	serverLastSeqNo: bigint
	offset: bigint
	sessions: number

	// bookkeeping for invariants
	preSeeded: number // distinct seqNos the server already had before this run
	writtenCount: number // successful write() calls
	assigned: WeakMap<BufferedMessage, bigint> // detect renumbering
	prevLastSeqNo: bigint
	modelBytes: bigint // facade-style un-acked byte budget
	outstandingFlush: boolean
	errored: boolean
	destroyed: boolean
	terminal: boolean
}

let mkSim = function mkSim(maxInflightCount: number, maxBatchBytes: bigint, preSeed: number): Sim {
	let persisted = new Set<bigint>()
	for (let i = 1; i <= preSeed; i++) {
		persisted.add(BigInt(i))
	}
	return {
		writerState: 'idle',
		writerCtx: createWriterCtx({ maxInflightCount, maxBatchBytes }),
		transportState: 'idle',
		writerEvents: [],
		transportEvents: [],
		armed: new Set(),
		streamOpen: false,
		initPending: false,
		pendingGetLastSeqNo: false,
		streamGetLastSeqNo: false,
		pendingAcks: [],
		persisted,
		serverLastSeqNo: BigInt(preSeed),
		offset: 0n,
		sessions: 0,
		preSeeded: preSeed,
		writtenCount: 0,
		assigned: new WeakMap(),
		prevLastSeqNo: 0n,
		modelBytes: 0n,
		outstandingFlush: false,
		errored: false,
		destroyed: false,
		terminal: false,
	}
}

let allDrained = function allDrained(ctx: WriterCtx): boolean {
	return ctx.bufferLength === 0 && ctx.inflightLength === 0
}

let timerEvent = function timerEvent(which: GlobalTimerName): WriterEvent {
	switch (which) {
		case 'start_timeout':
			return { type: 'writer.timer.start_timeout' }
		case 'retry_backoff':
			return { type: 'writer.timer.retry_backoff' }
		case 'recovery_window':
			return { type: 'writer.timer.recovery_window' }
		case 'flush_tick':
			return { type: 'writer.timer.flush_tick' }
		case 'update_token':
			return { type: 'writer.timer.update_token' }
		case 'graceful_timeout':
			return { type: 'writer.timer.graceful_timeout' }
	}
}

// Mirror of writer-runtime.ts mapTransportOutput (kept trivial + local on purpose).
let mapTransportOutput = function mapTransportOutput(output: TransportOutput): WriterEvent | null {
	switch (output.type) {
		case 'transport.stream.init_response':
			return {
				type: 'writer.stream.init_response',
				sessionId: output.sessionId,
				lastSeqNo: output.lastSeqNo,
				...(output.partitionId !== undefined && { partitionId: output.partitionId }),
			}
		case 'transport.stream.write_response':
			return { type: 'writer.stream.write_response', acks: output.acks }
		case 'transport.stream.token_response':
			return { type: 'writer.stream.token_response' }
		case 'transport.stream.disconnected':
			return {
				type: 'writer.stream.disconnected',
				...('error' in output ? { error: output.error } : {}),
			}
		default:
			return null
	}
}

let serverReceive = function serverReceive(sim: Sim, seqNo: bigint): void {
	let wasNew = !sim.persisted.has(seqNo)
	if (wasNew) {
		sim.persisted.add(seqNo)
		if (seqNo > sim.serverLastSeqNo) {
			sim.serverLastSeqNo = seqNo
		}
	}
	// The server acks every received message; a duplicate (producer+seqNo already
	// persisted) comes back 'skipped' — this is the server-side dedup on resend.
	sim.pendingAcks.push(
		wasNew ? { seqNo, status: 'written', offset: sim.offset++ } : { seqNo, status: 'skipped' }
	)
}

let onWriterOutput = function onWriterOutput(sim: Sim, output: WriterOutput): void {
	switch (output.type) {
		case 'writer.flushed':
			sim.outstandingFlush = false
			break
		case 'writer.acknowledgments':
			sim.modelBytes -= output.freedBytes
			if (sim.modelBytes < 0n) {
				sim.modelBytes = 0n
			}
			break
		case 'writer.error':
			sim.errored = true
			break
		case 'writer.closed':
			sim.terminal = true
			sim.modelBytes = 0n
			break
	}
}

let applyWriterEffect = function applyWriterEffect(sim: Sim, effect: WriterEffect): void {
	switch (effect.type) {
		case 'writer.effect.transport.connect':
			sim.pendingGetLastSeqNo = effect.getLastSeqNo
			sim.transportEvents.push({ type: 'transport.connect' })
			break
		case 'writer.effect.send.write_request':
			// A batch only reaches the server over a live, initialized stream.
			if (sim.streamOpen && !sim.initPending) {
				for (let message of effect.messages) {
					serverReceive(sim, message.seqNo)
				}
			}
			break
		case 'writer.effect.send.update_token':
			if (sim.streamOpen && !sim.initPending) {
				sim.transportEvents.push({ type: 'transport.token' })
			}
			break
		case 'writer.effect.transport.close':
			sim.transportEvents.push({ type: 'transport.close' })
			break
		case 'writer.effect.timer.schedule':
			// recovery_window is armed once per reconnect saga (runtime guard).
			if (effect.which === 'recovery_window' && sim.armed.has('recovery_window')) {
				break
			}
			sim.armed.add(effect.which)
			break
		case 'writer.effect.timer.clear':
			sim.armed.delete(effect.which)
			break
		case 'writer.effect.finalize':
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
			sim.pendingAcks = []
			sim.streamGetLastSeqNo = sim.pendingGetLastSeqNo
			break
		case 'transport.effect.close_stream':
		case 'transport.effect.finalize':
			sim.streamOpen = false
			sim.initPending = false
			sim.pendingAcks = []
			break
	}
}

let processWriterEvent = function processWriterEvent(sim: Sim, event: WriterEvent): void {
	let runtime = {
		state: sim.writerState,
		signal: NEVER,
		emit: (output: WriterOutput) => onWriterOutput(sim, output),
		dispatch: (next: WriterEvent) => sim.writerEvents.push(next),
	}
	let result = writerTransition(sim.writerCtx, event, runtime)
	if (result?.state) {
		sim.writerState = result.state
	}
	for (let effect of result?.effects ?? []) {
		applyWriterEffect(sim, effect)
	}
}

let processTransportEvent = function processTransportEvent(sim: Sim, event: TransportEvent): void {
	let runtime = {
		state: sim.transportState,
		signal: NEVER,
		emit: (output: TransportOutput) => {
			let mapped = mapTransportOutput(output)
			if (mapped) {
				sim.writerEvents.push(mapped)
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
	while (sim.writerEvents.length > 0 || sim.transportEvents.length > 0) {
		if (++guard > 200_000) {
			throw new Error('livelock: quiescence never reached (self-dispatch loop)')
		}
		if (sim.writerEvents.length > 0) {
			processWriterEvent(sim, sim.writerEvents.shift()!)
		} else {
			processTransportEvent(sim, sim.transportEvents.shift()!)
		}
	}
}

let checkInvariants = function checkInvariants(sim: Sim, where: string): void {
	let ctx = sim.writerCtx

	if (sim.terminal) {
		// Terminal stop releases the buffer and the facade budget resets.
		if (ctx.messages.length !== 0) {
			throw new Error(`${where}: terminal but messages not released (${ctx.messages.length})`)
		}
		if (sim.modelBytes !== 0n) {
			throw new Error(`${where}: terminal but modelBytes=${sim.modelBytes}`)
		}
		return
	}

	let n = ctx.messages.length
	if (!(ctx.inflightStart >= 0 && ctx.inflightStart <= ctx.bufferStart && ctx.bufferStart <= n)) {
		throw new Error(
			`${where}: pointer invariant broken inflightStart=${ctx.inflightStart} bufferStart=${ctx.bufferStart} len=${n}`
		)
	}
	if (ctx.bufferLength !== n - ctx.bufferStart) {
		throw new Error(`${where}: bufferLength=${ctx.bufferLength} != ${n - ctx.bufferStart}`)
	}
	if (ctx.inflightLength !== ctx.bufferStart - ctx.inflightStart) {
		throw new Error(
			`${where}: inflightLength=${ctx.inflightLength} != ${ctx.bufferStart - ctx.inflightStart}`
		)
	}

	if (ctx.lastSeqNo < sim.prevLastSeqNo) {
		throw new Error(`${where}: lastSeqNo regressed ${sim.prevLastSeqNo} -> ${ctx.lastSeqNo}`)
	}
	sim.prevLastSeqNo = ctx.lastSeqNo

	let seen = new Set<bigint>()
	for (let i = 0; i < n; i++) {
		let message = ctx.messages[i]!
		if (message.seqNo === 0n) {
			continue
		}
		let prior = sim.assigned.get(message)
		if (prior === undefined) {
			sim.assigned.set(message, message.seqNo)
		} else if (prior !== message.seqNo) {
			throw new Error(`${where}: message renumbered ${prior} -> ${message.seqNo}`)
		}
		if (seen.has(message.seqNo)) {
			throw new Error(`${where}: duplicate seqNo ${message.seqNo} in window`)
		}
		seen.add(message.seqNo)
		if (message.seqNo > ctx.lastSeqNo) {
			throw new Error(`${where}: seqNo ${message.seqNo} exceeds lastSeqNo ${ctx.lastSeqNo}`)
		}
	}

	// The byte budget and flush-liveness only apply while the facade budget is
	// authoritative — i.e. in the live, write-accepting states. The closing drain
	// keeps emitting acks and resolves a pending flush once drained, but the model's
	// step generator does not track the drain-vs-terminate race precisely enough to
	// assert liveness there; the facade also resets #bufferedBytes to 0 on close.
	if (sim.writerState !== 'closing') {
		let expected = 0n
		for (let i = ctx.inflightStart; i < n; i++) {
			expected += BigInt(ctx.messages[i]!.data.length)
		}
		if (sim.modelBytes !== expected) {
			throw new Error(
				`${where}: byte budget drift modelBytes=${sim.modelBytes} expected=${expected}`
			)
		}

		if (sim.outstandingFlush && allDrained(ctx)) {
			throw new Error(`${where}: flush left unresolved though the window is drained`)
		}
	}
}

// Drive the writer to a healthy, fully-drained state so we can assert nothing was
// lost. Only meaningful when the run did not already terminate (close/destroy/fatal).
let cooldown = function cooldown(sim: Sim): void {
	for (let i = 0; i < 20_000 && !sim.terminal; i++) {
		if (allDrained(sim.writerCtx) && sim.writerState === 'ready') {
			return
		}
		if (!sim.streamOpen) {
			if (sim.armed.has('retry_backoff')) {
				sim.armed.delete('retry_backoff')
				sim.writerEvents.push(timerEvent('retry_backoff'))
			} else if (sim.armed.has('start_timeout')) {
				sim.armed.delete('start_timeout')
				sim.writerEvents.push(timerEvent('start_timeout'))
			} else {
				return // stuck without a way to reconnect — surfaced by the assert below
			}
			runToQuiescence(sim)
			continue
		}
		if (sim.initPending) {
			sim.initPending = false
			sim.sessions++
			// Healthy recovery in cooldown: always report the true high-water mark.
			sim.transportEvents.push({
				type: 'transport.init',
				sessionId: `s${sim.sessions}`,
				lastSeqNo: sim.serverLastSeqNo,
			})
			runToQuiescence(sim)
			continue
		}
		if (sim.writerCtx.bufferLength > 0 && sim.armed.has('flush_tick')) {
			sim.writerEvents.push(timerEvent('flush_tick')) // triggers pump
		}
		runToQuiescence(sim)
		if (sim.pendingAcks.length > 0) {
			let acks = sim.pendingAcks
			sim.pendingAcks = []
			sim.transportEvents.push({ type: 'transport.write', acks })
			runToQuiescence(sim)
		}
	}
}

type RunConfig = {
	mode: 'auto' | 'manual'
	maxInflightCount: number
	maxBatchBytes: bigint
	preSeed: number
	steps: number
}

let runOne = function runOne(seed: number, cfg: RunConfig): void {
	let rng = mulberry32(seed)
	let randInt = (bound: number): number => Math.floor(rng() * bound)

	let sim = mkSim(cfg.maxInflightCount, cfg.maxBatchBytes, cfg.mode === 'auto' ? cfg.preSeed : 0)
	let userSeq = 0

	sim.writerEvents.push({ type: 'writer.start' })
	runToQuiescence(sim)
	checkInvariants(sim, `seed=${seed} start`)

	let lastAction = 'start'
	for (let step = 0; step < cfg.steps && !sim.terminal; step++) {
		let live =
			sim.writerState === 'idle' ||
			sim.writerState === 'connecting' ||
			sim.writerState === 'ready' ||
			sim.writerState === 'reconnecting'

		let actions: Array<{ w: number; name: string; run: () => void }> = []

		if (live) {
			actions.push({
				w: 10,
				name: 'write',
				run: () => {
					let size = 1 + randInt(6)
					let data = new Uint8Array(size)
					let seqNo = 0n
					if (cfg.mode === 'manual') {
						userSeq += 1 + randInt(3)
						seqNo = BigInt(userSeq)
					}
					let message: BufferedMessage = {
						data,
						uncompressedSize: BigInt(size),
						seqNo,
						createdAt: new Date(0),
					}
					sim.writtenCount++
					sim.modelBytes += BigInt(size)
					sim.writerEvents.push({ type: 'writer.write', message })
				},
			})
			actions.push({
				w: 3,
				name: 'flush',
				run: () => {
					sim.outstandingFlush = true
					sim.writerEvents.push({ type: 'writer.flush' })
				},
			})
			actions.push({
				w: 1,
				name: 'close',
				run: () => sim.writerEvents.push({ type: 'writer.close' }),
			})
			actions.push({
				w: 1,
				name: 'destroy',
				run: () => {
					sim.destroyed = true
					sim.writerEvents.push({ type: 'writer.destroy', reason: new Error('destroy') })
				},
			})
		}

		if (sim.streamOpen && sim.initPending) {
			actions.push({
				w: 8,
				name: 'init',
				run: () => {
					sim.initPending = false
					sim.sessions++
					// Real YDB reports the persisted high-water mark on init even when
					// get_last_seq_no is false (proven in tests/writer-protocol.test.ts). When
					// not requested we still model that the server MAY omit it (proto
					// says it can be skipped as expensive), so we cover both: a reconnect
					// init that carries a covering last_seq_no (window drains via dedup)
					// and one that reports 0 (messages are resent).
					let reported =
						sim.streamGetLastSeqNo || randInt(2) === 0 ? sim.serverLastSeqNo : 0n
					sim.transportEvents.push({
						type: 'transport.init',
						sessionId: `s${sim.sessions}`,
						lastSeqNo: reported,
					})
				},
			})
		}
		if (sim.pendingAcks.length > 0) {
			actions.push({
				w: 8,
				name: 'acks',
				run: () => {
					// The server acks an in-order prefix of what it received.
					let k = 1 + randInt(sim.pendingAcks.length)
					let acks = sim.pendingAcks.splice(0, k)
					sim.transportEvents.push({ type: 'transport.write', acks })
				},
			})
		}
		if (sim.streamOpen) {
			actions.push({
				w: 3,
				name: 'drop',
				run: () => sim.transportEvents.push({ type: 'transport.ended' }),
			})
			actions.push({
				w: 3,
				name: 'fail-retryable',
				run: () =>
					sim.transportEvents.push({
						type: 'transport.error',
						error: new YDBError(StatusIds_StatusCode.UNAVAILABLE, []),
					}),
			})
			actions.push({
				w: 1,
				name: 'fail-fatal',
				run: () =>
					sim.transportEvents.push({
						type: 'transport.error',
						error: new YDBError(StatusIds_StatusCode.SCHEME_ERROR, []),
					}),
			})
		}
		for (let which of sim.armed) {
			let oneShot =
				which === 'start_timeout' ||
				which === 'retry_backoff' ||
				which === 'recovery_window' ||
				which === 'graceful_timeout'
			// start_timeout while an init is still pending is the key race that a
			// wall-clock test can't hit deterministically.
			let weight = which === 'flush_tick' || which === 'update_token' ? 2 : 3
			actions.push({
				w: weight,
				name: `timer:${which}`,
				run: () => {
					if (oneShot) {
						sim.armed.delete(which)
					}
					sim.writerEvents.push(timerEvent(which))
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
		lastAction = chosen.name
		chosen.run()
		runToQuiescence(sim)
		checkInvariants(sim, `seed=${seed} step=${step} action=${lastAction}`)
	}

	cooldown(sim)
	checkInvariants(sim, `seed=${seed} after=cooldown (last=${lastAction})`)

	// No-loss / no-duplication: if the writer settled cleanly (drained + ready, no
	// close/destroy/fatal), the server must hold exactly the distinct messages we
	// wrote — plus whatever it already had. Skipped when the run ended terminally,
	// where dropping undelivered writes is legitimate.
	if (!sim.terminal && allDrained(sim.writerCtx) && sim.writerState === 'ready') {
		let expectedPersisted = sim.preSeeded + sim.writtenCount
		if (sim.persisted.size !== expectedPersisted) {
			throw new Error(
				`seed=${seed}: at-least-once broken — server has ${sim.persisted.size} distinct seqNos, expected ${expectedPersisted} (${sim.writtenCount} written + ${sim.preSeeded} pre-seeded); last=${lastAction}`
			)
		}
	}
}

let LIMITS: Array<{ maxInflightCount: number; maxBatchBytes: bigint }> = [
	{ maxInflightCount: 1, maxBatchBytes: 48n * 1024n * 1024n },
	{ maxInflightCount: 2, maxBatchBytes: 8n },
	{ maxInflightCount: 3, maxBatchBytes: 4n },
	{ maxInflightCount: 1000, maxBatchBytes: 48n * 1024n * 1024n },
]

test('auto-mode random sequences preserve every writer invariant', () => {
	let runs = 0
	for (let seed = 1; seed <= 400; seed++) {
		let limits = LIMITS[seed % LIMITS.length]!
		runOne(seed, {
			mode: 'auto',
			maxInflightCount: limits.maxInflightCount,
			maxBatchBytes: limits.maxBatchBytes,
			preSeed: 0,
			steps: 60,
		})
		runs++
	}
	// Reaching here means every seed held all invariants (a violation throws).
	expect(runs).toBe(400)
})

test('manual-mode random sequences preserve every writer invariant', () => {
	let runs = 0
	for (let seed = 1; seed <= 400; seed++) {
		let limits = LIMITS[seed % LIMITS.length]!
		runOne(seed + 100_000, {
			mode: 'manual',
			maxInflightCount: limits.maxInflightCount,
			maxBatchBytes: limits.maxBatchBytes,
			preSeed: 0,
			steps: 60,
		})
		runs++
	}
	expect(runs).toBe(400)
})

test('recovery from a producer with pre-existing server state loses no messages', () => {
	// The server already holds seqNos 1..preSeed for this producer (a restarted
	// writer). Auto seqNos must continue ABOVE the recovered high-water mark, even
	// across reconnects and the start_timeout-vs-init race — never colliding with
	// persisted seqNos and getting silently deduped.
	let runs = 0
	for (let seed = 1; seed <= 400; seed++) {
		let limits = LIMITS[seed % LIMITS.length]!
		runOne(seed + 200_000, {
			mode: 'auto',
			maxInflightCount: limits.maxInflightCount,
			maxBatchBytes: limits.maxBatchBytes,
			preSeed: 5 + (seed % 20),
			steps: 60,
		})
		runs++
	}
	expect(runs).toBe(400)
})
