import { loggers } from '@ydbjs/debug'

let dbg = loggers.topic.extend('queue')

export class AsyncPriorityQueue<T> implements AsyncIterable<T>, Disposable {
	private paused = false
	private closed = false
	private readonly heap: { value: T; priority: number }[] = []
	private pendingShift?: (value: IteratorResult<T>) => void
	private pendingResume?: () => void

	get size(): number {
		return this.heap.length
	}

	push(value: T, priority = 0) {
		if (this.closed) {
			dbg.log('push rejected, queue closed')
			throw new Error('Queue closed')
		}

		dbg.log('pushing item %o with priority %d, current size: %d', value, priority, this.heap.length)

		let left = 0
		let right = this.heap.length
		while (left < right) {
			let mid = (left + right) >> 1
			if (this.heap[mid]!.priority < priority) {
				right = mid
			} else {
				left = mid + 1
			}
		}

		this.heap.splice(left, 0, { value, priority })

		if (this.pendingShift && this.heap.length > 0) {
			dbg.log('resolving pending shift operation with item %o', this.heap[0])
			const next = this.heap.shift()!
			const resolve = this.pendingShift
			delete this.pendingShift
			resolve({ value: next.value, done: false })
		}

		dbg.log('item pushed, new size: %d', this.heap.length)
	}

	private async next(): Promise<IteratorResult<T>> {
		if (this.paused) {
			dbg.log('queue paused, waiting for resume')
			await new Promise<void>((resolve) => {
				this.pendingResume = resolve
			})
			dbg.log('queue resumed')
		}

		// Return done if closed and no items to process
		if (this.closed && this.heap.length === 0) {
			dbg.log('queue closed and empty, returning done')
			return { value: undefined as any, done: true }
		}

		if (this.heap.length > 0) {
			let next = this.heap.shift()!
			dbg.log('returning item %o with priority %d, remaining size: %d', next.value, next.priority, this.heap.length)
			return { value: next.value, done: false }
		}

		// If we reach here: not closed and no items in heap
		// Create pending operation to wait for new items
		dbg.log('queue empty, creating pending shift operation')
		return new Promise<IteratorResult<T>>((resolve) => {
			this.pendingShift = resolve
		})
	}

	pause() {
		dbg.log('pausing queue')
		this.paused = true
	}

	resume() {
		if (!this.paused) {
			return
		}

		dbg.log('resuming queue')
		this.paused = false
		if (this.pendingResume) {
			const resolve = this.pendingResume
			delete this.pendingResume
			resolve()
		}
	}

	close() {
		dbg.log('closing queue with %d pending items', this.heap.length)
		this.closed = true
		// Resolve any pending operations with done: true
		if (this.pendingShift) {
			dbg.log('resolving pending shift with done: true')
			let resolve = this.pendingShift
			delete this.pendingShift
			resolve({ value: undefined as any, done: true })
		}
		if (this.pendingResume) {
			dbg.log('resolving pending resume')
			let resolve = this.pendingResume
			delete this.pendingResume
			resolve()
		}
	}

	dispose() {
		dbg.log('disposing queue, clearing %d items', this.heap.length)
		// Clear the heap to prevent memory leaks
		this.heap.length = 0
		// Close and resolve pending operations
		this.close()
	}

	async *[Symbol.asyncIterator]() {
		dbg.log('starting async iteration')
		while (true) {
			// eslint-disable-next-line no-await-in-loop
			let { value, done } = await this.next()
			if (done) {
				dbg.log('async iteration completed')
				break
			}

			yield value
		}
	}

	[Symbol.dispose]() {
		this.dispose()
	}
}
