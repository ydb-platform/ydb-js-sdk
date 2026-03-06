import { expect, test } from 'vitest'
import { AsyncPriorityQueue, AsyncQueue } from './queue.ts'

test('processes priority items in descending order', async () => {
	let queue = new AsyncPriorityQueue<number>()

	queue.push(1, 1)
	queue.push(2, 3)
	queue.push(3, 2)

	let iterator = queue[Symbol.asyncIterator]()
	expect((await iterator.next()).value).toBe(2)
	expect((await iterator.next()).value).toBe(3)
	expect((await iterator.next()).value).toBe(1)
})

test('preserves insertion order for equal priorities', async () => {
	let queue = new AsyncPriorityQueue<number>()

	queue.push(10, 5)
	queue.push(20, 5)
	queue.push(30, 5)

	let iterator = queue[Symbol.asyncIterator]()
	expect((await iterator.next()).value).toBe(10)
	expect((await iterator.next()).value).toBe(20)
	expect((await iterator.next()).value).toBe(30)
})

test('resolves pending next when priority item is pushed', async () => {
	let queue = new AsyncPriorityQueue<number>()
	let iterator = queue[Symbol.asyncIterator]()
	let next = iterator.next()

	queue.push(42, 7)

	expect((await next).value).toBe(42)
})

test('close drains buffered priority items and then completes iteration', async () => {
	let queue = new AsyncPriorityQueue<number>()

	queue.push(1, 1)
	queue.push(2, 2)
	queue.close()

	let iterator = queue[Symbol.asyncIterator]()
	let first = await iterator.next()
	let second = await iterator.next()
	let done = await iterator.next()

	expect(first.done).toBe(false)
	expect(first.value).toBe(2)
	expect(second.done).toBe(false)
	expect(second.value).toBe(1)
	expect(done.done).toBe(true)
})

test('destroy drops buffered priority items and completes iteration', async () => {
	let queue = new AsyncPriorityQueue<number>()

	queue.push(1, 1)
	queue.push(2, 2)
	queue.destroy()

	let iterator = queue[Symbol.asyncIterator]()
	let done = await iterator.next()

	expect(done.done).toBe(true)
	expect(queue.size).toBe(0)
})

test('pause blocks priority delivery until resume', async () => {
	let queue = new AsyncPriorityQueue<number>()
	queue.pause()
	queue.push(1, 1)
	queue.push(2, 2)

	let results: number[] = []
	let iterator = queue[Symbol.asyncIterator]()
	let consumer = (async () => {
		let first = await iterator.next()
		if (!first.done) {
			results.push(first.value)
		}

		let second = await iterator.next()
		if (!second.done) {
			results.push(second.value)
		}
	})()

	process.nextTick(() => {
		expect(results).toEqual([])
		queue.resume()
	})

	await consumer

	expect(results).toEqual([2, 1])
})

test('close resolves pending next for paused priority queue with done', async () => {
	let queue = new AsyncPriorityQueue<number>()
	queue.pause()

	let iterator = queue[Symbol.asyncIterator]()
	let next = iterator.next()

	queue.close()

	let result = await next
	expect(result.done).toBe(true)
})

test('close and destroy are idempotent for priority queue', () => {
	let queue = new AsyncPriorityQueue<number>()
	queue.push(1, 1)

	queue.close()
	queue.close()
	expect(() => queue.push(2, 2)).toThrow('Queue closed')

	queue.destroy()
	queue.destroy()
	expect(queue.size).toBe(0)
	expect(() => queue.push(3, 3)).toThrow('Queue closed')
})

test('yields fifo items in insertion order', async () => {
	let queue = new AsyncQueue<number>()

	queue.push(1)
	queue.push(2)
	queue.push(3)

	let iterator = queue[Symbol.asyncIterator]()
	expect((await iterator.next()).value).toBe(1)
	expect((await iterator.next()).value).toBe(2)
	expect((await iterator.next()).value).toBe(3)
})

test('resolves pending next when fifo item is pushed', async () => {
	let queue = new AsyncQueue<number>()
	let iterator = queue[Symbol.asyncIterator]()
	let next = iterator.next()

	queue.push(99)

	expect((await next).value).toBe(99)
})

test('close drains buffered fifo items and then completes iteration', async () => {
	let queue = new AsyncQueue<number>()

	queue.push(10)
	queue.push(20)
	queue.close()

	let iterator = queue[Symbol.asyncIterator]()
	let first = await iterator.next()
	let second = await iterator.next()
	let done = await iterator.next()

	expect(first.done).toBe(false)
	expect(first.value).toBe(10)
	expect(second.done).toBe(false)
	expect(second.value).toBe(20)
	expect(done.done).toBe(true)
})

test('close rejects fifo push and preserves buffered size', () => {
	let queue = new AsyncQueue<number>()
	queue.push(1)
	queue.push(2)

	queue.close()

	expect(queue.size).toBe(2)
	expect(() => queue.push(3)).toThrow('Queue closed')
})

test('destroy drops buffered fifo items and completes iteration', async () => {
	let queue = new AsyncQueue<number>()

	queue.push(1)
	queue.push(2)
	queue.destroy()

	let iterator = queue[Symbol.asyncIterator]()
	let done = await iterator.next()

	expect(done.done).toBe(true)
	expect(queue.size).toBe(0)
})

test('pause blocks fifo delivery until resume', async () => {
	let queue = new AsyncQueue<number>()
	queue.pause()
	queue.push(5)
	queue.push(6)

	let results: number[] = []
	let iterator = queue[Symbol.asyncIterator]()
	let consumer = (async () => {
		let first = await iterator.next()
		if (!first.done) {
			results.push(first.value)
		}

		let second = await iterator.next()
		if (!second.done) {
			results.push(second.value)
		}
	})()

	process.nextTick(() => {
		expect(results).toEqual([])
		queue.resume()
	})

	await consumer

	expect(results).toEqual([5, 6])
})

test('close resolves pending next for paused fifo queue with done', async () => {
	let queue = new AsyncQueue<number>()
	queue.pause()

	let iterator = queue[Symbol.asyncIterator]()
	let next = iterator.next()

	queue.close()

	let result = await next
	expect(result.done).toBe(true)
})

test('close and destroy are idempotent for fifo queue', () => {
	let queue = new AsyncQueue<number>()
	queue.push(1)

	queue.close()
	queue.close()
	expect(() => queue.push(2)).toThrow('Queue closed')

	queue.destroy()
	queue.destroy()
	expect(queue.size).toBe(0)
	expect(() => queue.push(3)).toThrow('Queue closed')
})

test('symbol dispose delegates to destroy for both queues', () => {
	let fifo = new AsyncQueue<number>()
	fifo.push(1)
	fifo[Symbol.dispose]()
	expect(fifo.size).toBe(0)
	expect(() => fifo.push(2)).toThrow('Queue closed')

	let priority = new AsyncPriorityQueue<number>()
	priority.push(1, 1)
	priority[Symbol.dispose]()
	expect(priority.size).toBe(0)
	expect(() => priority.push(2, 2)).toThrow('Queue closed')
})

test('destroy completes paused priority iterator and resume keeps it completed', async () => {
	let queue = new AsyncPriorityQueue<number>()
	queue.pause()

	let iterator = queue[Symbol.asyncIterator]()
	let next = iterator.next()

	queue.destroy()

	let first = await next
	expect(first.done).toBe(true)

	queue.resume()

	let second = await iterator.next()
	expect(second.done).toBe(true)
})

test('destroy completes paused fifo iterator and resume keeps it completed', async () => {
	let queue = new AsyncQueue<number>()
	queue.pause()

	let iterator = queue[Symbol.asyncIterator]()
	let next = iterator.next()

	queue.destroy()

	let first = await next
	expect(first.done).toBe(true)

	queue.resume()

	let second = await iterator.next()
	expect(second.done).toBe(true)
})

test('reset resolves pending next and allows fifo reuse', async () => {
	let queue = new AsyncQueue<number>()
	let iterator = queue[Symbol.asyncIterator]()

	let pending = iterator.next()
	queue.reset()

	let done = await pending
	expect(done.done).toBe(true)

	let iteratorAfterReset = queue[Symbol.asyncIterator]()
	queue.push(7)
	let next = await iteratorAfterReset.next()
	expect(next.done).toBe(false)
	expect(next.value).toBe(7)
})

test('compacts fifo buffer after high consumption and preserves order', async () => {
	let queue = new AsyncQueue<number>()
	let total = 1300

	for (let i = 0; i < total; i += 1) {
		queue.push(i)
	}

	let iterator = queue[Symbol.asyncIterator]()

	for (let i = 0; i < 1024; i += 1) {
		// oxlint-disable-next-line no-await-in-loop
		let next = await iterator.next()
		expect(next.done).toBe(false)
		expect(next.value).toBe(i)
	}

	for (let i = 1024; i < total; i += 1) {
		// oxlint-disable-next-line no-await-in-loop
		let next = await iterator.next()
		expect(next.done).toBe(false)
		expect(next.value).toBe(i)
	}

	queue.push(total)
	let tail = await iterator.next()
	expect(tail.done).toBe(false)
	expect(tail.value).toBe(total)
})

test('uses right child branch during priority siftDown and keeps order', async () => {
	let queue = new AsyncPriorityQueue<string>()

	queue.push('p9', 9)
	queue.push('p7', 7)
	queue.push('p8', 8)
	queue.push('p1', 1)
	queue.push('p6', 6)

	let iterator = queue[Symbol.asyncIterator]()

	expect((await iterator.next()).value).toBe('p9')
	expect((await iterator.next()).value).toBe('p8')
	expect((await iterator.next()).value).toBe('p7')
	expect((await iterator.next()).value).toBe('p6')
	expect((await iterator.next()).value).toBe('p1')
})
