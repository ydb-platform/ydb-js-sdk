import { expect, test } from 'vitest'

import { type StabilitySample, TopicStability } from './topic-stability.ts'

let monitor = () =>
	new TopicStability({
		warmupMs: 10_000,
		windowMs: 10_000,
		rps: 100,
		memoryGrowthBytes: { rss: 1000, heapUsed: 100 },
	})
let sample = (seconds: number, memory = { rss: 1000, heapUsed: 100 }): StabilitySample => ({
	elapsedMs: seconds * 1000,
	accepted: seconds * 100,
	committed: seconds * 100,
	memory,
})

test('ignores warmup allocations and tolerates a GC sawtooth at sustained throughput', () => {
	let check = monitor()
	for (let second = 0; second <= 40; second++) {
		check.observe(
			sample(second, second < 10 || second % 2 ? { rss: 5000, heapUsed: 500 } : undefined)
		)
		check.recordLatency(500)
	}
	expect(check.finish()).toEqual({ windows: 3, baseline: { rss: 1000, heapUsed: 100 } })
})

test('rejects steadily retained native memory even with complete message delivery', () => {
	let check = monitor()
	expect(() => {
		for (let second = 0; second <= 60; second++)
			check.observe(sample(second, { rss: 1000 + second * 120, heapUsed: 100 }))
	}).toThrow('rss grew')
	expect(() => check.finish()).toThrow('rss grew')
})

test('rejects backpressure that throttles generation below the declared load', () => {
	let check = monitor()
	expect(() => {
		for (let second = 0; second <= 30; second++)
			check.observe({ ...sample(second), accepted: second * 50, committed: second * 50 })
	}).toThrow('Throughput below')
})

test('rejects a reader backlog even when writers sustain the declared load', () => {
	let check = monitor()
	check.observe(sample(10))
	expect(() => check.observe({ ...sample(11), committed: 0 })).toThrow('Backlog exceeds')
})

test('rejects missing counters missing samples and excessive latency', () => {
	let missing = monitor()
	expect(() => missing.observe({ ...sample(10), memory: { rss: 1000 } })).toThrow(
		'memory counter'
	)
	let stalled = monitor()
	stalled.observe(sample(10))
	expect(() => stalled.observe(sample(21))).toThrow('without a stability sample')
	let slow = monitor()
	slow.observe(sample(10))
	slow.observe(sample(20))
	slow.observe(sample(30))
	expect(() => slow.recordLatency(10_001)).toThrow('latency exceeds')
	expect(() => slow.finish()).toThrow('latency exceeds')
})

test('never qualifies a run that ended during warmup or baseline collection', () => {
	for (let duration of [5, 15, 25]) {
		let check = monitor()
		for (let second = 0; second <= duration; second++) check.observe(sample(second))
		expect(() => check.finish()).toThrow('baseline and at least one comparison window')
	}
})

test('enforces the absolute RSS limit even during warmup', () => {
	let check = monitor()
	expect(() => check.observe(sample(1, { rss: 3 * 1024 ** 3, heapUsed: 100 }))).toThrow('2 GiB')
})
