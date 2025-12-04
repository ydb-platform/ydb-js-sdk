import { expect, test } from 'vitest'
import { AsyncPriorityQueue } from './queue.ts'

test('processes items in priority order', async () => {
	let queue = new AsyncPriorityQueue<number>()

	queue.push(1, 1) // Priority 1
	queue.push(2, 3) // Priority 3
	queue.push(3, 2) // Priority 2

	let iterator = queue[Symbol.asyncIterator]()
	expect((await iterator.next()).value).toBe(2) // Highest priority
	expect((await iterator.next()).value).toBe(3) // Next highest priority
	expect((await iterator.next()).value).toBe(1) // Lowest priority
})

test('handles async iteration', async () => {
	let queue = new AsyncPriorityQueue<number>()

	queue.push(1, 1)
	queue.push(2, 2)
	queue.push(3, 3)

	let results: number[] = []
	for await (let item of queue) {
		results.push(item)
		if (results.length === 3) break
	}

	expect(results).toEqual([3, 2, 1])
})

test('resolves pending shift when items are added', async () => {
	let queue = new AsyncPriorityQueue<number>()

	let iterator = queue[Symbol.asyncIterator]()
	let nextPromise = iterator.next()
	queue.push(42, 1)

	expect((await nextPromise).value).toBe(42)
})

test('throws an error when pushing to a closed queue', () => {
	let queue = new AsyncPriorityQueue<number>()
	queue.close()

	expect(() => queue.push(1)).toThrow('Queue closed')
})

test('returns done when iterating over closed queue', async () => {
	let queue = new AsyncPriorityQueue<number>()
	queue.close()

	let iterator = queue[Symbol.asyncIterator]()
	let result = await iterator.next()
	expect(result.done).toBe(true)
})

test('handles closed queue properly', async () => {
	let queue = new AsyncPriorityQueue<number>()

	let iterator = queue[Symbol.asyncIterator]()
	let nextPromise = iterator.next()

	// Close the queue while iterator is waiting
	queue.close()

	// Should resolve with done: true
	let result = await nextPromise
	expect(result.done).toBe(true)

	// Subsequent pushes should throw
	expect(() => queue.push(1, 1)).toThrow('Queue closed')
	expect(() => queue.push(2, 2)).toThrow('Queue closed')

	expect(queue.size).toBe(0)
})

test('dispose clears heap and prevents memory leaks', () => {
	let queue = new AsyncPriorityQueue<number>()

	// Add some items to the queue
	queue.push(1, 1)
	queue.push(2, 2)
	queue.push(3, 3)
	expect(queue.size).toBe(3)

	// Dispose the queue
	queue.dispose()

	// Queue should be empty after dispose (heap cleared)
	expect(queue.size).toBe(0)

	// Subsequent pushes should throw
	expect(() => queue.push(4, 4)).toThrow('Queue closed')
})

test('pauses and resumes processing as expected', async () => {
	let queue = new AsyncPriorityQueue<number>()
	queue.pause()
	queue.push(1, 1)
	queue.push(2, 2)

	let results: number[] = []
	let iterator = queue[Symbol.asyncIterator]()
	let consumer = (async () => {
		let first = await iterator.next()
		if (!first.done) results.push(first.value) // should wait until resume
		let second = await iterator.next()
		if (!second.done) results.push(second.value)
	})()

	process.nextTick(() => {
		expect(results).toEqual([])
		queue.resume()
	})

	await consumer

	expect(results).toEqual([2, 1])
})

test('disposes resources properly', () => {
	let queue = new AsyncPriorityQueue<number>()
	queue.push(1, 1)
	queue.push(2, 2)

	expect(queue.size).toBe(2)

	queue[Symbol.dispose]()

	expect(queue.size).toBe(0)
	expect(() => queue.push(3, 3)).toThrow('Queue closed')
})

test('resume does nothing when not paused', () => {
	let queue = new AsyncPriorityQueue<number>()
	queue.push(1, 1)

	// Call resume when not paused - should do nothing
	queue.resume()

	expect(queue.size).toBe(1)
})

test('close resolves pending resume operations', async () => {
	let queue = new AsyncPriorityQueue<number>()
	queue.pause()

	let iterator = queue[Symbol.asyncIterator]()
	let nextPromise = iterator.next()

	// Close the queue while waiting for resume
	queue.close()

	// Should resolve with done: true, not hang forever
	let result = await nextPromise
	expect(result.done).toBe(true)
})

test('close vs dispose behavior', async () => {
	let queue = new AsyncPriorityQueue<number>()

	// Add some items
	queue.push(1, 1)
	queue.push(2, 2)
	expect(queue.size).toBe(2)

	// close() should stop accepting new items but keep existing ones
	queue.close()
	expect(queue.size).toBe(2) // Still has items

	// Can't add new items
	expect(() => queue.push(3, 3)).toThrow('Queue closed')

	// But can still iterate over existing items
	let iterator = queue[Symbol.asyncIterator]()
	let first = await iterator.next()
	expect(first.done).toBe(false)
	expect(first.value).toBe(2) // Highest priority

	// Create new queue for dispose test
	let queue2 = new AsyncPriorityQueue<number>()
	queue2.push(5, 5)
	queue2.push(6, 6)
	expect(queue2.size).toBe(2)

	// dispose() should clear everything
	queue2.dispose()
	expect(queue2.size).toBe(0) // Cleared

	expect(() => queue2.push(7, 7)).toThrow('Queue closed')
})
