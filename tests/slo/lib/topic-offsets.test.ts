import { expect, test } from 'vitest'

import { TopicOffsets } from './topic-offsets.ts'

test('keeps a million consecutive offsets in one exact range', () => {
	let offsets = new TopicOffsets()
	for (let sequence = 1; sequence <= 1_000_000; sequence++)
		offsets.set(sequence, 2n ** 60n + BigInt(sequence))
	expect(offsets.size).toBe(1_000_000)
	expect(offsets.rangeCount).toBe(1)
	for (let sequence of [1, 500_001, 1_000_000])
		expect(offsets.get(sequence)).toBe(2n ** 60n + BigInt(sequence))
	expect(offsets.missing(1, 1_000_010)).toEqual({
		count: 10,
		examples: Array.from({ length: 10 }, (_, i) => 1_000_001 + i),
	})
})

test('preserves gaps and merges late observations against an independent map', () => {
	let offsets = new TopicOffsets()
	let reference = new Map<number, bigint>()
	let random = 17
	let remaining = Array.from({ length: 200 }, (_, i) => i + 1)
	while (remaining.length) {
		random = (Math.imul(random, 1664525) + 1013904223) >>> 0
		let sequence = remaining.splice(random % remaining.length, 1)[0]!
		let offset = BigInt(sequence + Math.floor(sequence / 7) * 3)
		offsets.set(sequence, offset)
		reference.set(sequence, offset)
		for (let i = 1; i <= 205; i++) expect(offsets.get(i)).toBe(reference.get(i))
		for (let first of [1, 50, 150, 205]) {
			let missing = Array.from({ length: 206 - first }, (_, i) => first + i).filter(
				(i) => !reference.has(i)
			)
			expect(offsets.missing(first, 205)).toEqual({
				count: missing.length,
				examples: missing.slice(0, 10),
			})
		}
	}
	expect(offsets.size).toBe(reference.size)
})

test('fails on excessive fragmented history instead of growing without a bound', () => {
	let offsets = new TopicOffsets()
	for (let sequence = 1; sequence <= 10_000; sequence++)
		offsets.set(sequence, BigInt(sequence * 2))
	expect(() => offsets.set(10_001, 20_002n)).toThrow('10000 disjoint ranges')
	expect(offsets.size).toBe(10_000)
})
