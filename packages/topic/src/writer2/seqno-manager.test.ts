import { expect, test } from 'vitest'
import { SeqNoManager } from './seqno-manager.js'

test('auto mode generates sequential numbers starting from initial + 1', () => {
	let manager = new SeqNoManager(5n)

	expect(manager.getNext()).toBe(6n)
	expect(manager.getNext()).toBe(7n)

	let state = manager.getState()
	expect(state.mode).toBe('auto')
	expect(state.nextSeqNo).toBe(8n)
	expect(state.lastSeqNo).toBe(7n)
})

test('auto mode rejects manual seqNo once started', () => {
	let manager = new SeqNoManager()

	manager.getNext()

	expect(() => manager.getNext(10n)).toThrowError(
		/Cannot mix auto and manual seqNo modes/
	)
})

test('initialize adjusts next seqNo in auto mode', () => {
	let manager = new SeqNoManager()
	manager.initialize(42n)

	expect(manager.getNext()).toBe(43n)
	let state = manager.getState()
	expect(state.lastSeqNo).toBe(43n)
	expect(state.nextSeqNo).toBe(44n)
})

test('manual mode accepts strictly increasing user seqNo', () => {
	let manager = new SeqNoManager()

	expect(manager.getNext(100n)).toBe(100n)
	expect(manager.getNext(101n)).toBe(101n)

	let state = manager.getState()
	expect(state.mode).toBe('manual')
	expect(state.highestUserSeqNo).toBe(101n)
	expect(state.lastSeqNo).toBe(101n)
})

test('manual mode rejects missing seqNo once started', () => {
	let manager = new SeqNoManager()

	manager.getNext(10n)

	expect(() => manager.getNext()).toThrowError(
		/Cannot mix manual and auto seqNo modes/
	)
})

test('manual mode enforces strictly increasing seqNo', () => {
	let manager = new SeqNoManager()

	manager.getNext(10n)

	expect(() => manager.getNext(10n)).toThrowError(
		/SeqNo must be strictly increasing/
	)
})
