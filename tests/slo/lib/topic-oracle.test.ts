import { expect, test } from 'vitest'

import { TopicOracle } from './topic-oracle.ts'

let makeOracle = function makeOracle(partitions = 1, messageBytes = 128): TopicOracle {
	return new TopicOracle({ runId: 'oracle-test', partitions, messageBytes })
}

let message = function message(
	oracle: TopicOracle,
	partition: number,
	sequence: number,
	offset = BigInt(sequence - 1)
) {
	return {
		payload: oracle.createPayload(partition, sequence),
		producer: oracle.producerId(partition),
		partitionId: BigInt(partition),
		offset,
	}
}

test('reconciles accepted acknowledged delivered and committed records on every producer', () => {
	let oracle = makeOracle(2)
	for (let partition of [0, 1]) {
		oracle.accept(partition, 1)
		oracle.accept(partition, 2)
		let first = oracle.observe(message(oracle, partition, 1, 100n))
		let second = oracle.observe(message(oracle, partition, 2, 104n))
		oracle.acknowledge(partition, 2)
		oracle.commit([first, second])
	}
	expect(oracle.complete).toBe(true)
	expect(oracle.snapshot().totals).toEqual({
		accepted: 4,
		acknowledged: 4,
		delivered: 4,
		committed: 4,
		duplicates: 0,
	})
	expect(oracle.snapshot().pending).toEqual({
		unacknowledged: 0,
		undelivered: 0,
		uncommitted: 0,
		acknowledgedUndelivered: 0,
		uncertain: 0,
	})
	expect(() => JSON.stringify(oracle.snapshot())).not.toThrow()
})

test('rejects a missing first business record instead of establishing a new baseline', () => {
	let oracle = makeOracle()
	oracle.accept(0, 1)
	oracle.accept(0, 2)
	oracle.acknowledge(0, 2)
	expect(() => oracle.observe(message(oracle, 0, 2))).toThrow('forward gap')
	expect(oracle.complete).toBe(false)
	expect(oracle.snapshot().producers[0]!.missing.acknowledgedUndelivered).toEqual([1])
})

test('detects a lost accepted record without relying on SDK sequence numbers', () => {
	let oracle = makeOracle()
	for (let sequence of [1, 2, 3]) oracle.accept(0, sequence)
	oracle.acknowledge(0, 3)
	oracle.observe(message(oracle, 0, 1, 0n))
	// Adjacent partition offsets cannot reveal a record dropped before SDK seqNo assignment.
	expect(() => oracle.observe(message(oracle, 0, 3, 1n))).toThrow('forward gap')
	expect(oracle.snapshot().pending.acknowledgedUndelivered).toBe(1)
	expect(oracle.snapshot().producers[0]!.missing.undelivered).toEqual([2])
})

test('reports a missing acknowledged tail without requiring a later message', () => {
	let oracle = makeOracle()
	for (let sequence of [1, 2, 3]) oracle.accept(0, sequence)
	oracle.acknowledge(0, 3)
	oracle.commit([oracle.observe(message(oracle, 0, 1))])
	expect(oracle.complete).toBe(false)
	expect(oracle.snapshot().pending).toMatchObject({ acknowledgedUndelivered: 2, uncertain: 0 })
	expect(oracle.snapshot().producers[0]!.missing.undelivered).toEqual([2, 3])
	expect(oracle.snapshot().errors).toEqual([])
})

test('distinguishes an unacknowledged uncertain tail from acknowledged delivery failure', () => {
	let oracle = makeOracle()
	oracle.accept(0, 1)
	oracle.accept(0, 2)
	oracle.acknowledge(0, 1)
	oracle.commit([oracle.observe(message(oracle, 0, 1))])
	expect(oracle.complete).toBe(false)
	expect(oracle.snapshot().pending).toMatchObject({
		unacknowledged: 1,
		acknowledgedUndelivered: 0,
		uncertain: 1,
	})
	expect(oracle.snapshot().errors).toEqual([])
})

test('requires a write acknowledgment even when delivery proves the record was published', () => {
	let oracle = makeOracle()
	oracle.accept(0, 1)
	oracle.commit([oracle.observe(message(oracle, 0, 1))])
	expect(oracle.complete).toBe(false)
	expect(oracle.snapshot().pending).toMatchObject({
		unacknowledged: 1,
		undelivered: 0,
		uncertain: 0,
	})
	oracle.acknowledge(0, 1)
	expect(oracle.complete).toBe(true)
})

test('requires the reader commit acknowledgment after delivery', () => {
	let oracle = makeOracle()
	oracle.accept(0, 1)
	oracle.acknowledge(0, 1)
	let observed = oracle.observe(message(oracle, 0, 1))
	expect(oracle.complete).toBe(false)
	expect(oracle.snapshot().pending.uncommitted).toBe(1)
	expect(oracle.snapshot().producers[0]!.missing.uncommitted).toEqual([1])
	oracle.commit([observed])
	expect(oracle.complete).toBe(true)
})

test('reconciles a lost commit acknowledgment from a regranted partition watermark', () => {
	let oracle = makeOracle()
	for (let sequence of [1, 2, 3]) {
		oracle.accept(0, sequence)
		oracle.observe(message(oracle, 0, sequence, BigInt(sequence + 40)))
	}
	oracle.acknowledge(0, 3)
	oracle.commit([{ partition: 0, sequence: 1 }])
	expect(oracle.snapshot().pending.uncommitted).toBe(2)
	oracle.confirmCommittedOffset(0, 44n)
	expect(oracle.complete).toBe(true)
	expect(oracle.snapshot().totals.committed).toBe(3)
})

test('never substitutes a committed watermark for undelivered accepted records', () => {
	let oracle = makeOracle()
	for (let sequence of [1, 2, 3]) oracle.accept(0, sequence)
	oracle.acknowledge(0, 3)
	oracle.observe(message(oracle, 0, 1, 9n))
	oracle.confirmCommittedOffset(0, 100n)
	expect(oracle.complete).toBe(false)
	expect(oracle.snapshot().totals).toMatchObject({ delivered: 1, committed: 1 })
	expect(oracle.snapshot().pending.acknowledgedUndelivered).toBe(2)
	oracle.observe(message(oracle, 0, 2, 10n))
	expect(oracle.snapshot().totals.committed).toBe(2)
	oracle.observe(message(oracle, 0, 3, 11n))
	expect(oracle.complete).toBe(true)
})

test('keeps server watermarks monotonic and direct commit acknowledgments idempotent', () => {
	let oracle = makeOracle()
	for (let sequence of [1, 2, 3]) {
		oracle.accept(0, sequence)
		oracle.observe(message(oracle, 0, sequence, BigInt(sequence + 9)))
	}
	oracle.acknowledge(0, 3)
	oracle.confirmCommittedOffset(0, 11n)
	expect(oracle.snapshot().totals.committed).toBe(1)
	oracle.confirmCommittedOffset(0, 0n)
	oracle.confirmCommittedOffset(0, 11n)
	expect(oracle.snapshot().totals.committed).toBe(1)
	oracle.confirmCommittedOffset(0, 12n)
	expect(oracle.snapshot().totals.committed).toBe(2)
	oracle.commit([{ partition: 0, sequence: 3 }])
	oracle.confirmCommittedOffset(0, 13n)
	oracle.commit([{ partition: 0, sequence: 1 }])
	expect(oracle.complete).toBe(true)
	expect(oracle.snapshot().totals).toMatchObject({ committed: 3, duplicates: 0 })
})

test('advances through a long history with repeated and increasing watermarks', () => {
	let oracle = makeOracle(1, 64)
	let count = 10_000
	for (let sequence = 1; sequence <= count; sequence++) {
		oracle.accept(0, sequence)
		oracle.observe(message(oracle, 0, sequence))
	}
	oracle.acknowledge(0, count)
	for (let offset = 1; offset <= count; offset++) {
		oracle.confirmCommittedOffset(0, BigInt(offset))
		oracle.confirmCommittedOffset(0, BigInt(offset))
		oracle.confirmCommittedOffset(0, 0n)
	}
	expect(oracle.complete).toBe(true)
	expect(oracle.snapshot().totals).toMatchObject({
		delivered: count,
		committed: count,
		duplicates: 0,
	})
})

test('rejects an invalid server watermark as a sticky verifier failure', () => {
	let oracle = makeOracle()
	expect(() => oracle.confirmCommittedOffset(0, -1n)).toThrow('invalid committed offset')
	expect(oracle.snapshot().failureCount).toBe(1)
})

test('allows redelivery at the original offset without inflating coverage', () => {
	let oracle = makeOracle()
	for (let sequence of [1, 2]) oracle.accept(0, sequence)
	let first = oracle.observe(message(oracle, 0, 1, 30n))
	let second = oracle.observe(message(oracle, 0, 2, 31n))
	let repeated = oracle.observe(message(oracle, 0, 1, 30n))
	oracle.acknowledge(0, 2)
	oracle.commit([first, second, repeated])
	oracle.commit([repeated])
	expect(oracle.complete).toBe(true)
	expect(oracle.snapshot().totals).toEqual({
		accepted: 2,
		acknowledged: 2,
		delivered: 2,
		committed: 2,
		duplicates: 1,
	})
})

test('rejects a duplicate publication of one business ID at another offset', () => {
	let oracle = makeOracle()
	oracle.accept(0, 1)
	oracle.observe(message(oracle, 0, 1, 30n))
	expect(() => oracle.observe(message(oracle, 0, 1, 31n))).toThrow('duplicate publication')
	expect(oracle.snapshot().totals.delivered).toBe(1)
	expect(oracle.complete).toBe(false)
})

test('keeps an ordering failure after a late record fills the gap', () => {
	let oracle = makeOracle()
	for (let sequence of [1, 2]) oracle.accept(0, sequence)
	expect(() => oracle.observe(message(oracle, 0, 2))).toThrow('forward gap')
	expect(() => oracle.observe(message(oracle, 0, 1))).toThrow('reorder')
	oracle.acknowledge(0, 2)
	oracle.commit([
		{ partition: 0, sequence: 1 },
		{ partition: 0, sequence: 2 },
	])
	expect(oracle.snapshot().totals).toMatchObject({
		accepted: 2,
		acknowledged: 2,
		delivered: 2,
		committed: 2,
	})
	expect(oracle.complete).toBe(false)
	expect(oracle.snapshot().errors[0]).toContain('forward gap')
})

test('detects corruption at every byte of a payload', () => {
	for (let position = 0; position < 128; position++) {
		let oracle = makeOracle()
		oracle.accept(0, 1)
		let corrupted = message(oracle, 0, 1)
		corrupted.payload[position] = corrupted.payload[position]! ^ 1
		expect(() => oracle.observe(corrupted), `byte ${position}`).toThrow(
			/magic|version|different run|partition|sequence|corruption/
		)
		expect(oracle.snapshot().failureCount).toBe(1)
		expect(oracle.complete).toBe(false)
	}
})

test('validates sliced payload views and the minimum payload size', () => {
	let oracle = makeOracle(1, 64)
	oracle.accept(0, 1)
	let observed = message(oracle, 0, 1)
	let backing = new Uint8Array(100)
	backing.set(observed.payload, 20)
	observed.payload = backing.subarray(20, 84)
	expect(oracle.observe(observed)).toEqual({ partition: 0, sequence: 1 })
})

test('rejects malformed lengths and payloads from a different run', () => {
	let oracle = makeOracle()
	oracle.accept(0, 1)
	let truncated = message(oracle, 0, 1)
	truncated.payload = truncated.payload.subarray(0, 127)
	expect(() => oracle.observe(truncated)).toThrow('Payload length')
	let other = new TopicOracle({ runId: 'different-run', partitions: 1, messageBytes: 128 })
	expect(() => oracle.observe(message(other, 0, 1))).toThrow('different run')
})

test('rejects incorrect producer partition and offset metadata', () => {
	for (let replacement of [{ producer: 'wrong' }, { partitionId: 1n }, { offset: -1n }]) {
		let oracle = makeOracle()
		oracle.accept(0, 1)
		expect(() => oracle.observe({ ...message(oracle, 0, 1), ...replacement })).toThrow(
			/wrong producer|partition metadata|invalid offset/
		)
		expect(oracle.snapshot().totals.delivered).toBe(0)
		expect(oracle.complete).toBe(false)
	}
})

test('rejects two distinct business records at the same partition offset', () => {
	let oracle = makeOracle()
	oracle.accept(0, 1)
	oracle.accept(0, 2)
	oracle.observe(message(oracle, 0, 1, 9n))
	expect(() => oracle.observe(message(oracle, 0, 2, 9n))).toThrow('did not advance')
})

test('never accepts an empty run or an idle configured producer', () => {
	let oracle = makeOracle(2)
	expect(oracle.complete).toBe(false)
	oracle.accept(0, 1)
	oracle.acknowledge(0, 1)
	oracle.commit([oracle.observe(message(oracle, 0, 1))])
	expect(oracle.complete).toBe(false)
	expect(oracle.snapshot().producers[1]!.accepted).toBe(0)
})

test('keeps explicit failures after all records reconcile and bounds error examples', () => {
	let oracle = makeOracle()
	oracle.fail('worker exited unexpectedly')
	for (let i = 0; i < 30; i++) oracle.fail(`failure ${i}`)
	oracle.accept(0, 1)
	oracle.acknowledge(0, 1)
	oracle.commit([oracle.observe(message(oracle, 0, 1))])
	expect(oracle.complete).toBe(false)
	expect(oracle.snapshot().failureCount).toBe(31)
	expect(oracle.snapshot().errors).toHaveLength(20)
	expect(oracle.snapshot().errors[0]).toBe('worker exited unexpectedly')
})

test('rejects invalid acceptance acknowledgments observations and commits', () => {
	let skipped = makeOracle()
	expect(() => skipped.accept(0, 2)).toThrow('expected 1')
	let unaccepted = makeOracle()
	expect(() => unaccepted.acknowledge(0, 1)).toThrow('invalid acknowledged watermark')
	expect(() => unaccepted.observe(message(unaccepted, 0, 1))).toThrow('unaccepted')
	expect(() => unaccepted.commit([{ partition: 0, sequence: 1 }])).toThrow('unobserved')
	for (let invalid of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
		let oracle = makeOracle()
		expect(() => oracle.accept(0, invalid)).toThrow('Invalid business sequence')
	}
})

test('keeps acknowledgment checkpoints idempotent and bounds missing examples', () => {
	let oracle = makeOracle()
	for (let sequence = 1; sequence <= 25; sequence++) oracle.accept(0, sequence)
	oracle.acknowledge(0, 25)
	oracle.acknowledge(0, 5)
	oracle.acknowledge(0, 25)
	let snapshot = oracle.snapshot()
	expect(snapshot.totals.acknowledged).toBe(25)
	expect(snapshot.pending.acknowledgedUndelivered).toBe(25)
	expect(snapshot.producers[0]!.missing.undelivered).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
	snapshot.errors.push('external mutation')
	expect(oracle.snapshot().errors).toEqual([])
})

test('rejects invalid profile dimensions before creating a run', () => {
	for (let invalid of [
		{ runId: '' },
		{ partitions: 0 },
		{ partitions: 1.5 },
		{ messageBytes: 63 },
		{ messageBytes: Infinity },
	]) {
		expect(
			() => new TopicOracle({ runId: 'test', partitions: 1, messageBytes: 128, ...invalid })
		).toThrow(RangeError)
	}
})
