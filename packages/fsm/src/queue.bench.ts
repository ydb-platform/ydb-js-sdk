import assert from 'node:assert/strict'

import { bench } from 'vitest'

import { AsyncQueue } from './queue.js'

// One operation includes queue creation, N deliveries and disposal.
// hz counts complete bursts/s; buffering, waiter creation and Promise delivery are measured together.
let timing = { time: 200, iterations: 3, warmupTime: 50, warmupIterations: 2 }

for (let size of [128, 4000, 64000]) {
	bench(
		`queue buffered take / ${size} items per burst`,
		async () => {
			using queue = new AsyncQueue<number>()
			for (let index = 0; index < size; index++) {
				queue.push(1)
			}
			let delivered = 0
			for (let index = 0; index < size; index++) {
				// oxlint-disable-next-line no-await-in-loop
				let next = await queue.take()
				if (!next.done) {
					delivered += next.value
				}
			}
			assert.equal(delivered, size)
			assert.equal(queue.size, 0)
		},
		timing
	)

	bench(
		`queue one parked take / ${size} items per burst`,
		async () => {
			using queue = new AsyncQueue<number>()
			let delivered = 0
			for (let index = 0; index < size; index++) {
				let pending = queue.take()
				queue.push(1)
				// oxlint-disable-next-line no-await-in-loop
				let next = await pending
				if (!next.done) {
					delivered += next.value
				}
			}
			assert.equal(delivered, size)
			assert.equal(queue.size, 0)
		},
		timing
	)

	bench(
		`queue mass parked takes / ${size} waiters per burst`,
		async () => {
			using queue = new AsyncQueue<number>()
			let pending: Array<Promise<IteratorResult<number>>> = []
			for (let index = 0; index < size; index++) {
				pending.push(queue.take())
			}
			for (let index = 0; index < size; index++) {
				queue.push(1)
			}
			let results = await Promise.all(pending)
			let delivered = 0
			for (let result of results) {
				if (!result.done) {
					delivered += result.value
				}
			}
			assert.equal(delivered, size)
			assert.equal(queue.size, 0)
		},
		timing
	)
}
