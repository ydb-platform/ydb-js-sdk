import { expect, test } from 'vitest'
import { SeqNoShiftBuilder } from './seqno-shift-builder.js'

test('builds empty shifts array when no shifts added', () => {
	let builder = new SeqNoShiftBuilder()
	let shifts = builder.build()

	expect(shifts.length).toBe(0)
})

test('builds single shift for one message', () => {
	let builder = new SeqNoShiftBuilder()
	builder.addShift(1n, 101n)
	let shifts = builder.build()

	expect(shifts.length).toBe(1)
	expect(shifts[0]?.start).toBe(1n)
	expect(shifts[0]?.end).toBe(2n)
	expect(shifts[0]?.delta).toBe(100n)
})

test('merges consecutive shifts with same delta', () => {
	let builder = new SeqNoShiftBuilder()
	builder.addShift(1n, 101n)
	builder.addShift(2n, 102n)
	builder.addShift(3n, 103n)
	let shifts = builder.build()

	expect(shifts.length).toBe(1)
	expect(shifts[0]?.start).toBe(1n)
	expect(shifts[0]?.end).toBe(4n)
	expect(shifts[0]?.delta).toBe(100n)
})

test('creates separate shifts for different deltas', () => {
	let builder = new SeqNoShiftBuilder()
	builder.addShift(1n, 101n) // delta = 100
	builder.addShift(2n, 102n) // delta = 100
	builder.addShift(5n, 210n) // delta = 205 (different!)
	let shifts = builder.build()

	expect(shifts.length).toBe(2)
	expect(shifts[0]?.start).toBe(1n)
	expect(shifts[0]?.end).toBe(3n)
	expect(shifts[0]?.delta).toBe(100n)
	expect(shifts[1]?.start).toBe(5n)
	expect(shifts[1]?.end).toBe(6n)
	expect(shifts[1]?.delta).toBe(205n)
})

test('creates separate shifts for non-consecutive seqNo', () => {
	let builder = new SeqNoShiftBuilder()
	builder.addShift(1n, 101n) // delta = 100
	builder.addShift(2n, 102n) // delta = 100
	builder.addShift(5n, 105n) // delta = 100, but gap in seqNo
	let shifts = builder.build()

	expect(shifts.length).toBe(2)
	expect(shifts[0]?.start).toBe(1n)
	expect(shifts[0]?.end).toBe(3n)
	expect(shifts[0]?.delta).toBe(100n)
	expect(shifts[1]?.start).toBe(5n)
	expect(shifts[1]?.end).toBe(6n)
	expect(shifts[1]?.delta).toBe(100n)
})

test('ignores shifts where oldSeqNo equals newSeqNo', () => {
	let builder = new SeqNoShiftBuilder()
	builder.addShift(1n, 101n)
	builder.addShift(2n, 2n) // No shift
	builder.addShift(3n, 103n)
	let shifts = builder.build()

	expect(shifts.length).toBe(2)
	expect(shifts[0]?.start).toBe(1n)
	expect(shifts[0]?.end).toBe(2n)
	expect(shifts[1]?.start).toBe(3n)
	expect(shifts[1]?.end).toBe(4n)
})

test('handles negative deltas', () => {
	let builder = new SeqNoShiftBuilder()
	builder.addShift(100n, 50n) // delta = -50
	builder.addShift(101n, 51n) // delta = -50
	let shifts = builder.build()

	expect(shifts.length).toBe(1)
	expect(shifts[0]?.start).toBe(100n)
	expect(shifts[0]?.end).toBe(102n)
	expect(shifts[0]?.delta).toBe(-50n)
})

test('flush can be called multiple times safely', () => {
	let builder = new SeqNoShiftBuilder()
	builder.addShift(1n, 101n)
	builder.flush()
	builder.flush()
	builder.addShift(2n, 102n)
	builder.flush()
	let shifts = builder.build()

	expect(shifts.length).toBe(2)
	expect(shifts[0]?.start).toBe(1n)
	expect(shifts[1]?.start).toBe(2n)
})

test('reset clears all state', () => {
	let builder = new SeqNoShiftBuilder()
	builder.addShift(1n, 101n)
	builder.addShift(2n, 102n)
	builder.reset()

	expect(builder.build().length).toBe(0)

	builder.addShift(5n, 105n)
	let shifts = builder.build()
	expect(shifts.length).toBe(1)
	expect(shifts[0]?.start).toBe(5n)
})

test('build can be called multiple times', () => {
	let builder = new SeqNoShiftBuilder()
	builder.addShift(1n, 101n)

	let shifts1 = builder.build()
	let shifts2 = builder.build()

	expect(shifts1.length).toBe(1)
	expect(shifts2.length).toBe(1)
	expect(shifts1[0]?.start).toBe(shifts2[0]?.start)
})

test('handles large sequences', () => {
	let builder = new SeqNoShiftBuilder()
	for (let i = 0; i < 1000; i++) {
		builder.addShift(BigInt(i + 1), BigInt(i + 1001))
	}
	let shifts = builder.build()

	expect(shifts.length).toBe(1)
	expect(shifts[0]?.start).toBe(1n)
	expect(shifts[0]?.end).toBe(1001n)
	expect(shifts[0]?.delta).toBe(1000n)
})
