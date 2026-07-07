import { expect, test } from 'vitest'

import type { TransitionRuntime } from '@ydbjs/fsm'

import {
	type TransportEffect,
	type TransportEvent,
	type TransportOutput,
	type TransportState,
	transportTransition,
} from './transport-state.ts'
import type { WriteAck } from './types.ts'

type Driven = {
	state: TransportState
	effects: TransportEffect[]
	emitted: TransportOutput[]
}

let drive = function drive(state: TransportState, event: TransportEvent): Driven {
	let emitted: TransportOutput[] = []
	let runtime: TransitionRuntime<TransportState, TransportEvent, TransportOutput> = {
		state,
		signal: new AbortController().signal,
		emit: (output) => emitted.push(output),
		dispatch: () => {},
	}

	let result = transportTransition({}, event, runtime)

	return {
		state: result?.state ?? state,
		effects: result?.effects ?? [],
		emitted,
	}
}

let effectTypes = function effectTypes(effects: TransportEffect[]): string[] {
	return effects.map((effect) => effect.type)
}

let ack = function ack(seqNo: bigint): WriteAck {
	return { seqNo, status: 'written' }
}

// ── idle ────────────────────────────────────────────────────────────────────────

test('opens the stream on connect from idle', () => {
	let d = drive('idle', { type: 'transport.connect' })
	expect(d.state).toBe('connecting')
	expect(effectTypes(d.effects)).toEqual(['transport.effect.open_stream'])
})

test('finalizes on close from idle', () => {
	let d = drive('idle', { type: 'transport.close' })
	expect(d.state).toBe('closed')
	expect(effectTypes(d.effects)).toEqual(['transport.effect.finalize'])
})

test('ignores unrelated events while idle', () => {
	let d = drive('idle', { type: 'transport.write', acks: [ack(1n)] })
	expect(d.state).toBe('idle')
	expect(d.effects).toHaveLength(0)
	expect(d.emitted).toHaveLength(0)
})

// ── connecting ──────────────────────────────────────────────────────────────────

test('becomes ready and emits the init response', () => {
	let d = drive('connecting', { type: 'transport.init', sessionId: 's1', lastSeqNo: 7n })
	expect(d.state).toBe('ready')
	expect(d.emitted).toEqual([
		{ type: 'transport.stream.init_response', sessionId: 's1', lastSeqNo: 7n },
	])
})

test('carries the partitionId in the init response', () => {
	let d = drive('connecting', {
		type: 'transport.init',
		sessionId: 's1',
		lastSeqNo: 0n,
		partitionId: 3n,
	})
	expect(d.emitted[0]).toMatchObject({ partitionId: 3n })
})

test('emits a write response while connecting without changing state', () => {
	let d = drive('connecting', { type: 'transport.write', acks: [ack(1n), ack(2n)] })
	expect(d.state).toBe('connecting')
	expect(d.emitted).toEqual([
		{ type: 'transport.stream.write_response', acks: [ack(1n), ack(2n)] },
	])
})

test('emits a token response while connecting', () => {
	let d = drive('connecting', { type: 'transport.token' })
	expect(d.emitted).toEqual([{ type: 'transport.stream.token_response' }])
})

test('disconnects on stream end while connecting', () => {
	let d = drive('connecting', { type: 'transport.ended' })
	expect(d.state).toBe('disconnected')
	expect(effectTypes(d.effects)).toEqual(['transport.effect.close_stream'])
	expect(d.emitted).toEqual([{ type: 'transport.stream.disconnected' }])
})

test('reopens the stream on connect while connecting', () => {
	let d = drive('connecting', { type: 'transport.connect' })
	expect(d.state).toBe('connecting')
	expect(effectTypes(d.effects)).toEqual(['transport.effect.open_stream'])
})

test('closes while connecting', () => {
	let d = drive('connecting', { type: 'transport.close' })
	expect(d.state).toBe('closed')
	expect(effectTypes(d.effects)).toEqual([
		'transport.effect.close_stream',
		'transport.effect.finalize',
	])
})

// ── ready ─────────────────────────────────────────────────────────────────────

test('emits a write response while ready', () => {
	let d = drive('ready', { type: 'transport.write', acks: [ack(5n)] })
	expect(d.state).toBe('ready')
	expect(d.emitted).toEqual([{ type: 'transport.stream.write_response', acks: [ack(5n)] }])
})

test('stays ready on a second init response', () => {
	let d = drive('ready', { type: 'transport.init', sessionId: 's2', lastSeqNo: 1n })
	expect(d.state).toBe('ready')
	expect(d.emitted[0]).toMatchObject({ type: 'transport.stream.init_response', sessionId: 's2' })
})

test('disconnects with the error on a stream error while ready', () => {
	let error = new Error('boom')
	let d = drive('ready', { type: 'transport.error', error })
	expect(d.state).toBe('disconnected')
	expect(effectTypes(d.effects)).toEqual(['transport.effect.close_stream'])
	expect(d.emitted).toEqual([{ type: 'transport.stream.disconnected', error }])
})

test('reopens the stream on connect while ready', () => {
	let d = drive('ready', { type: 'transport.connect' })
	expect(d.state).toBe('connecting')
	expect(effectTypes(d.effects)).toEqual(['transport.effect.open_stream'])
})

test('closes while ready', () => {
	let d = drive('ready', { type: 'transport.close' })
	expect(d.state).toBe('closed')
	expect(effectTypes(d.effects)).toEqual([
		'transport.effect.close_stream',
		'transport.effect.finalize',
	])
})

// ── disconnected ────────────────────────────────────────────────────────────────

test('reconnects from disconnected on connect', () => {
	let d = drive('disconnected', { type: 'transport.connect' })
	expect(d.state).toBe('connecting')
	expect(effectTypes(d.effects)).toEqual(['transport.effect.open_stream'])
})

test('closes from disconnected', () => {
	let d = drive('disconnected', { type: 'transport.close' })
	expect(d.state).toBe('closed')
	expect(effectTypes(d.effects)).toEqual(['transport.effect.finalize'])
})

test('ignores stream messages while disconnected', () => {
	let d = drive('disconnected', { type: 'transport.write', acks: [ack(1n)] })
	expect(d.state).toBe('disconnected')
	expect(d.effects).toHaveLength(0)
	expect(d.emitted).toHaveLength(0)
})

// ── destroy / closed ────────────────────────────────────────────────────────────

test('destroys from any live state', () => {
	for (let state of ['idle', 'connecting', 'ready', 'disconnected'] as TransportState[]) {
		let d = drive(state, { type: 'transport.destroy', reason: new Error('x') })
		expect(d.state).toBe('closed')
		expect(effectTypes(d.effects)).toEqual([
			'transport.effect.close_stream',
			'transport.effect.finalize',
		])
	}
})

test('ignores everything once closed', () => {
	expect(drive('closed', { type: 'transport.connect' }).state).toBe('closed')
	expect(drive('closed', { type: 'transport.destroy' }).effects).toHaveLength(0)
	expect(drive('closed', { type: 'transport.write', acks: [ack(1n)] }).emitted).toHaveLength(0)
})
