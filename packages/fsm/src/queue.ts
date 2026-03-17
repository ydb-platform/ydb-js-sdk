type ShiftResolver<T> = (value: IteratorResult<T>) => void
type ResumeResolver = () => void

type DequeueResult<T> = { hasValue: true; value: T } | { hasValue: false }

export class QueueClosedError extends Error {
	constructor(message = 'Queue closed') {
		super(message)
		this.name = 'QueueClosedError'
	}
}

export abstract class AbstractAsyncQueue<T, P> implements AsyncIterable<T>, Disposable {
	private paused = false
	private closed = false
	private destroyed = false

	private pendingShift: ShiftResolver<T>[] = []
	private pendingResume: ResumeResolver[] = []

	get size(): number {
		return this.getBufferSize()
	}

	get isPaused(): boolean {
		return this.paused
	}

	get isClosed(): boolean {
		return this.closed
	}

	get isDestroyed(): boolean {
		return this.destroyed
	}

	protected pushInternal(value: T, options: P): void {
		if (this.closed || this.destroyed) {
			throw new QueueClosedError()
		}

		this.enqueue(value, options)
		this.resolvePendingShift()
	}

	pause(): void {
		if (this.paused || this.destroyed) {
			return
		}

		this.paused = true
	}

	resume(): void {
		if (!this.paused || this.destroyed) {
			return
		}

		this.paused = false
		this.resolvePendingResume()
		this.resolvePendingShift()
		this.resolvePendingDoneIfNeeded()
	}

	close(): void {
		if (this.closed || this.destroyed) {
			return
		}

		this.closed = true
		this.paused = false
		this.resolvePendingResume()
		this.resolvePendingShift()
		this.resolvePendingDoneIfNeeded()
	}

	destroy(): void {
		if (this.destroyed) {
			return
		}

		this.destroyed = true
		this.closed = true
		this.paused = false
		this.clearBuffer()
		this.resolvePendingResume()
		this.resolvePendingDone()
	}

	reset(): void {
		this.paused = false
		this.closed = false
		this.destroyed = false
		this.clearBuffer()
		this.resolvePendingResume()
		this.resolvePendingDone()
	}

	dispose(): void {
		this.destroy()
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			// eslint-disable-next-line no-await-in-loop
			let next = await this.next()
			if (next.done) {
				return
			}

			yield next.value
		}
	}

	[Symbol.dispose](): void {
		this.dispose()
	}

	private async next(): Promise<IteratorResult<T>> {
		if (this.destroyed) {
			return { value: undefined as never, done: true }
		}

		if (this.paused) {
			await this.waitForResume()
			if (this.destroyed) {
				return { value: undefined as never, done: true }
			}
		}

		let item = this.dequeue()
		if (item.hasValue) {
			return { value: item.value, done: false }
		}

		if (this.closed || this.destroyed) {
			return { value: undefined as never, done: true }
		}

		return new Promise<IteratorResult<T>>((resolve) => {
			this.pendingShift.push(resolve)
		})
	}

	private waitForResume(): Promise<void> {
		if (!this.paused || this.destroyed) {
			return Promise.resolve()
		}

		return new Promise<void>((resolve) => {
			this.pendingResume.push(resolve)
		})
	}

	private resolvePendingResume(): void {
		while (this.pendingResume.length > 0) {
			let resolve = this.pendingResume.shift()
			if (!resolve) {
				continue
			}

			resolve()
		}
	}

	private resolvePendingShift(): void {
		if (this.paused || this.destroyed) {
			return
		}

		while (this.pendingShift.length > 0 && this.getBufferSize() > 0) {
			let resolve = this.pendingShift.shift()
			if (!resolve) {
				continue
			}

			let item = this.dequeue()
			if (!item.hasValue) {
				break
			}

			resolve({ value: item.value, done: false })
		}
	}

	private resolvePendingDoneIfNeeded(): void {
		if ((this.closed || this.destroyed) && this.getBufferSize() === 0) {
			this.resolvePendingDone()
		}
	}

	private resolvePendingDone(): void {
		while (this.pendingShift.length > 0) {
			let resolve = this.pendingShift.shift()
			if (!resolve) {
				continue
			}

			resolve({ value: undefined as never, done: true })
		}
	}

	protected abstract enqueue(value: T, options: P): void
	protected abstract dequeue(): DequeueResult<T>
	protected abstract clearBuffer(): void
	protected abstract getBufferSize(): number
}

export class AsyncQueue<T> extends AbstractAsyncQueue<T, void> {
	private values: Array<T | undefined> = []
	private head = 0
	private tail = 0

	push(value: T): void {
		this.pushInternal(value, undefined)
	}

	protected enqueue(value: T): void {
		this.values[this.tail] = value
		this.tail += 1
	}

	protected dequeue(): DequeueResult<T> {
		if (this.head >= this.tail) {
			return { hasValue: false }
		}

		let value = this.values[this.head] as T
		this.values[this.head] = undefined
		this.head += 1

		this.compactIfNeeded()

		return { hasValue: true, value }
	}

	protected clearBuffer(): void {
		this.values.length = 0
		this.head = 0
		this.tail = 0
	}

	protected getBufferSize(): number {
		return this.tail - this.head
	}

	private compactIfNeeded(): void {
		let consumed = this.head
		let remaining = this.tail - this.head

		if (consumed < 1024 || consumed < remaining) {
			return
		}

		this.values = this.values.slice(this.head, this.tail)
		this.tail = remaining
		this.head = 0
	}
}

type PriorityNode<T> = {
	value: T
	priority: number
	sequence: number
}

export class AsyncPriorityQueue<T> extends AbstractAsyncQueue<T, number> {
	private heap: PriorityNode<T>[] = []
	private sequence = 0

	push(value: T, priority = 0): void {
		this.pushInternal(value, priority)
	}

	protected enqueue(value: T, priority: number): void {
		let node: PriorityNode<T> = {
			value,
			priority,
			sequence: this.sequence,
		}

		this.sequence += 1
		this.heap.push(node)
		this.siftUp(this.heap.length - 1)
	}

	protected dequeue(): DequeueResult<T> {
		if (this.heap.length === 0) {
			return { hasValue: false }
		}

		let root = this.heap[0] as PriorityNode<T>
		let last = this.heap.pop()

		if (this.heap.length > 0 && last) {
			this.heap[0] = last
			this.siftDown(0)
		}

		return { hasValue: true, value: root.value }
	}

	protected clearBuffer(): void {
		this.heap.length = 0
	}

	protected getBufferSize(): number {
		return this.heap.length
	}

	private siftUp(index: number): void {
		let child = index

		while (child > 0) {
			let parent = (child - 1) >> 1
			let childNode = this.heap[child] as PriorityNode<T>
			let parentNode = this.heap[parent] as PriorityNode<T>

			if (!this.isHigherPriority(childNode, parentNode)) {
				break
			}

			this.heap[child] = parentNode
			this.heap[parent] = childNode
			child = parent
		}
	}

	private siftDown(index: number): void {
		let parent = index
		let size = this.heap.length

		while (true) {
			let left = parent * 2 + 1
			let right = left + 1
			let highest = parent

			if (left < size) {
				let leftNode = this.heap[left] as PriorityNode<T>
				let highestNode = this.heap[highest] as PriorityNode<T>
				if (this.isHigherPriority(leftNode, highestNode)) {
					highest = left
				}
			}

			if (right < size) {
				let rightNode = this.heap[right] as PriorityNode<T>
				let highestNode = this.heap[highest] as PriorityNode<T>
				if (this.isHigherPriority(rightNode, highestNode)) {
					highest = right
				}
			}

			if (highest === parent) {
				return
			}

			let tmp = this.heap[parent] as PriorityNode<T>
			this.heap[parent] = this.heap[highest] as PriorityNode<T>
			this.heap[highest] = tmp
			parent = highest
		}
	}

	private isHigherPriority(left: PriorityNode<T>, right: PriorityNode<T>): boolean {
		if (left.priority !== right.priority) {
			return left.priority > right.priority
		}

		return left.sequence < right.sequence
	}
}
