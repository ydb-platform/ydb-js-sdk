import { expect, test } from 'vitest'
import { SeqNoResolver } from './seqno-resolver.js'

test('returns original seqNo when no shifts recorded', () => {
	let resolver = new SeqNoResolver()

	expect(resolver.resolveSeqNo(1n)).toBe(1n)
	expect(resolver.resolveSeqNo(123n)).toBe(123n)
})

test('resolves seqNo inside a single shift', () => {
	let resolver = new SeqNoResolver()
	resolver.applyShift({ start: 10n, end: 13n, delta: 100n })

	expect(resolver.resolveSeqNo(10n)).toBe(110n)
	expect(resolver.resolveSeqNo(12n)).toBe(112n)
	expect(resolver.resolveSeqNo(13n)).toBe(13n)
})

test('ignores zero-length and zero-delta shifts', () => {
	let resolver = new SeqNoResolver()
	resolver.applyShift({ start: 5n, end: 5n, delta: 99n })
	resolver.applyShift({ start: 7n, end: 9n, delta: 0n })

	expect(resolver.getShifts().length).toBe(0)
})

test('merges adjacent shifts with identical delta', () => {
	let resolver = new SeqNoResolver()
	resolver.applyShift({ start: 1n, end: 3n, delta: 100n })
	resolver.applyShift({ start: 3n, end: 6n, delta: 100n })

	let shifts = resolver.getShifts()
	expect(shifts.length).toBe(1)
	expect(shifts[0]).toEqual({ start: 1n, end: 6n, delta: 100n })
})

test('adds new segment when delta changes', () => {
	let resolver = new SeqNoResolver()
	resolver.applyShift({ start: 1n, end: 4n, delta: 100n })
	resolver.applyShift({ start: 4n, end: 6n, delta: 50n })

	let shifts = resolver.getShifts()
	expect(shifts.length).toBe(2)
	expect(shifts[0]).toEqual({ start: 1n, end: 4n, delta: 100n })
	expect(shifts[1]).toEqual({ start: 4n, end: 6n, delta: 50n })
})

test('composes sequential shifts to final seqNo', () => {
	let resolver = new SeqNoResolver()
	resolver.applyShift({ start: 1n, end: 4n, delta: 100n })
	resolver.applyShift({ start: 101n, end: 104n, delta: 100n })

	expect(resolver.resolveSeqNo(1n)).toBe(201n)
	expect(resolver.resolveSeqNo(3n)).toBe(203n)
})

test('applyShifts helper applies list in order', () => {
	let resolver = new SeqNoResolver()
	resolver.applyShifts([
		{ start: 1n, end: 3n, delta: 100n },
		{ start: 3n, end: 5n, delta: 150n },
	])

	expect(resolver.getShifts()).toEqual([
		{ start: 1n, end: 3n, delta: 100n },
		{ start: 3n, end: 5n, delta: 150n },
	])
})

test('throws when overlapping shift is applied', () => {
	let resolver = new SeqNoResolver()
	resolver.applyShift({ start: 1n, end: 5n, delta: 100n })

	expect(() => resolver.applyShift({ start: 4n, end: 7n, delta: 50n })).toThrowError(
		/Internal error: overlapping seqNo shifts detected/
	)
})

test('reset clears all recorded shifts', () => {
	let resolver = new SeqNoResolver()
	resolver.applyShift({ start: 1n, end: 5n, delta: 100n })
	resolver.reset()

	expect(resolver.getShifts().length).toBe(0)
	expect(resolver.resolveSeqNo(2n)).toBe(2n)
})
