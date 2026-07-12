type ShiftResolver<T> = (value: IteratorResult<T>) => void
// The void parameter (rather than none) lets take()'s generic gate racer park in
// #pendingResume and #pendingShift through one signature.
type ResumeResolver = (value: void) => void

type DequeueResult<T> = { hasValue: true; value: T } | { hasValue: false }

export class QueueClosedError extends Error {
	constructor(message = 'Queue closed') {
		super(message)
		this.name = 'QueueClosedError'
	}
}

export abstract class AbstractAsyncQueue<T, P> implements AsyncIterable<T>, Disposable {
	#paused = false
	#closed = false
	#destroyed = false

	// Set by fail() so the iterator throws this error once the buffer drains,
	// instead of ending silently. Lets a producer terminate the stream with a
	// reason without wrapping the iterator (which would tax every happy-path item).
	#failure: { error: unknown } | null = null

	#pendingShift: ShiftResolver<T>[] = []
	#pendingResume: ResumeResolver[] = []

	get size(): number {
		return this.getBufferSize()
	}

	get isPaused(): boolean {
		return this.#paused
	}

	get isClosed(): boolean {
		return this.#closed
	}

	get isDestroyed(): boolean {
		return this.#destroyed
	}

	protected pushInternal(value: T, options: P): void {
		if (this.#closed || this.#destroyed) {
			throw new QueueClosedError()
		}

		this.enqueue(value, options)
		this.#resolvePendingShift()
	}

	pause(): void {
		if (this.#paused || this.#destroyed) {
			return
		}

		this.#paused = true
	}

	resume(): void {
		if (!this.#paused || this.#destroyed) {
			return
		}

		this.#paused = false
		this.#resolvePendingResume()
		this.#resolvePendingShift()
		this.#resolvePendingDoneIfNeeded()
	}

	close(): void {
		if (this.#closed || this.#destroyed) {
			return
		}

		this.#closed = true
		this.#paused = false
		this.#resolvePendingResume()
		this.#resolvePendingShift()
		this.#resolvePendingDoneIfNeeded()
	}

	// Seal the queue like close(), but make the iterator throw `error` after the
	// buffered items drain. Buffered values are delivered first because they are
	// already-committed facts (e.g. server acks the consumer must not miss) —
	// dropping them would misreport what happened before the failure. The tail is
	// bounded: push() after fail() throws, so only items buffered at failure time
	// remain. For an immediate stop that discards the buffer, use destroy().
	fail(error: unknown): void {
		if (this.#closed || this.#destroyed) {
			return
		}

		this.#failure = { error }
		this.close()
	}

	destroy(): void {
		if (this.#destroyed) {
			return
		}

		this.#destroyed = true
		this.#closed = true
		this.#paused = false
		this.clearBuffer()
		this.#resolvePendingResume()
		this.#resolvePendingDone()
	}

	reset(): void {
		this.#paused = false
		this.#closed = false
		this.#destroyed = false
		this.#failure = null
		this.clearBuffer()
		this.#resolvePendingResume()
		this.#resolvePendingDone()
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			// oxlint-disable-next-line no-await-in-loop
			let next = await this.#next()
			if (next.done) {
				if (this.#failure) {
					throw this.#failure.error
				}

				return
			}

			yield next.value
		}
	}

	// One cancellable dequeue step with the iterator's exact contract — pause and the
	// drain-then-throw of fail() — plus abort: throws signal.reason if the signal fires
	// while waiting. Unlike racing iterator.next() with abortable() (a plain
	// Promise.race that leaves the underlying next() pending), losing the race removes
	// the parked waiter synchronously, so a cancelled take() can never be handed (and
	// thus swallow) an item. For a bounded wait compose the deadline at the call site:
	// linkSignals(signal, AbortSignal.timeout(ms)).
	async take(signal?: AbortSignal): Promise<IteratorResult<T>> {
		signal?.throwIfAborted()

		for (;;) {
			if (this.#destroyed) {
				return { value: undefined as never, done: true }
			}

			if (this.#paused) {
				// Wait for resume(), then re-evaluate from the top.
				// oxlint-disable-next-line no-await-in-loop
				await this.#parkCancellable(this.#pendingResume, signal)
				continue
			}

			let item = this.dequeue()
			if (item.hasValue) {
				return { value: item.value, done: false }
			}
			if (this.#closed) {
				if (this.#failure) {
					throw this.#failure.error
				}
				return { value: undefined as never, done: true }
			}

			// oxlint-disable-next-line no-await-in-loop
			let result = await this.#parkCancellable(this.#pendingShift, signal)
			// close()/destroy() settles parked waiters with done — mirror the
			// iterator's drain-then-throw before reporting the end.
			if (result.done && this.#failure) {
				throw this.#failure.error
			}
			return result
		}
	}

	// Park a resolver in `gate` and race it against the caller's abort. On abort the
	// waiter is spliced out BEFORE the reject, so `indexOf !== -1` proves it was not
	// and will never be served — unparking is atomic, no item can be handed to a
	// cancelled take().
	async #parkCancellable<V>(
		gate: Array<(value: V) => void>,
		signal: AbortSignal | undefined
	): Promise<V> {
		let parked = Promise.withResolvers<V>()
		let waiter = (value: V) => parked.resolve(value)
		gate.push(waiter)

		let onAbort = () => {
			let index = gate.indexOf(waiter)
			if (index !== -1) {
				gate.splice(index, 1)
			}
			parked.reject(signal!.reason)
		}
		signal?.addEventListener('abort', onAbort, { once: true })

		try {
			return await parked.promise
		} finally {
			signal?.removeEventListener('abort', onAbort)
		}
	}

	[Symbol.dispose](): void {
		this.destroy()
	}

	async #next(): Promise<IteratorResult<T>> {
		if (this.#destroyed) {
			return { value: undefined as never, done: true }
		}

		if (this.#paused) {
			await this.#waitForResume()
			if (this.#destroyed) {
				return { value: undefined as never, done: true }
			}
		}

		let item = this.dequeue()
		if (item.hasValue) {
			return { value: item.value, done: false }
		}

		if (this.#closed || this.#destroyed) {
			return { value: undefined as never, done: true }
		}

		return new Promise<IteratorResult<T>>((resolve) => {
			this.#pendingShift.push(resolve)
		})
	}

	#waitForResume(): Promise<void> {
		if (!this.#paused || this.#destroyed) {
			return Promise.resolve()
		}

		return new Promise<void>((resolve) => {
			this.#pendingResume.push(resolve)
		})
	}

	#resolvePendingResume(): void {
		while (this.#pendingResume.length > 0) {
			let resolve = this.#pendingResume.shift()!
			resolve()
		}
	}

	#resolvePendingShift(): void {
		if (this.#paused || this.#destroyed) {
			return
		}

		while (this.#pendingShift.length > 0 && this.getBufferSize() > 0) {
			let item = this.dequeue()
			if (!item.hasValue) {
				break
			}

			let resolve = this.#pendingShift.shift()!
			resolve({ value: item.value, done: false })
		}
	}

	#resolvePendingDoneIfNeeded(): void {
		if ((this.#closed || this.#destroyed) && this.getBufferSize() === 0) {
			this.#resolvePendingDone()
		}
	}

	#resolvePendingDone(): void {
		while (this.#pendingShift.length > 0) {
			let resolve = this.#pendingShift.shift()!
			resolve({ value: undefined as never, done: true })
		}
	}

	protected abstract enqueue(value: T, options: P): void
	protected abstract dequeue(): DequeueResult<T>
	protected abstract clearBuffer(): void
	protected abstract getBufferSize(): number
}

export class AsyncQueue<T> extends AbstractAsyncQueue<T, void> {
	#values: Array<T | undefined> = []
	#head = 0
	#tail = 0

	push(value: T): void {
		this.pushInternal(value, undefined)
	}

	protected enqueue(value: T): void {
		this.#values[this.#tail] = value
		this.#tail += 1
	}

	protected dequeue(): DequeueResult<T> {
		if (this.#head >= this.#tail) {
			return { hasValue: false }
		}

		let value = this.#values[this.#head]!
		this.#values[this.#head] = undefined
		this.#head += 1

		this.#compactIfNeeded()

		return { hasValue: true, value }
	}

	protected clearBuffer(): void {
		this.#values.length = 0
		this.#head = 0
		this.#tail = 0
	}

	protected getBufferSize(): number {
		return this.#tail - this.#head
	}

	#compactIfNeeded(): void {
		let consumed = this.#head
		let remaining = this.#tail - this.#head

		if (consumed < 1024 || consumed < remaining) {
			return
		}

		this.#values = this.#values.slice(this.#head, this.#tail)
		this.#tail = remaining
		this.#head = 0
	}
}

type PriorityNode<T> = {
	value: T
	priority: number
	sequence: number
}

export class AsyncPriorityQueue<T> extends AbstractAsyncQueue<T, number> {
	#heap: PriorityNode<T>[] = []
	#sequence = 0

	push(value: T, priority = 0): void {
		this.pushInternal(value, priority)
	}

	protected enqueue(value: T, priority: number): void {
		let node: PriorityNode<T> = {
			value,
			priority,
			sequence: this.#sequence,
		}

		this.#sequence += 1
		this.#heap.push(node)
		this.#siftUp(this.#heap.length - 1)
	}

	protected dequeue(): DequeueResult<T> {
		if (this.#heap.length === 0) {
			return { hasValue: false }
		}

		let root = this.#heap[0]!
		let last = this.#heap.pop()!

		if (this.#heap.length > 0) {
			this.#heap[0] = last
			this.#siftDown(0)
		}

		return { hasValue: true, value: root.value }
	}

	protected clearBuffer(): void {
		this.#heap.length = 0
	}

	protected getBufferSize(): number {
		return this.#heap.length
	}

	#siftUp(index: number): void {
		let child = index

		while (child > 0) {
			let parent = (child - 1) >> 1
			let childNode = this.#heap[child]!
			let parentNode = this.#heap[parent]!

			if (!this.#isHigherPriority(childNode, parentNode)) {
				break
			}

			this.#heap[child] = parentNode
			this.#heap[parent] = childNode
			child = parent
		}
	}

	#siftDown(index: number): void {
		let parent = index
		let size = this.#heap.length

		while (true) {
			let left = parent * 2 + 1
			let right = left + 1
			let highest = parent

			if (left < size && this.#isHigherPriority(this.#heap[left]!, this.#heap[highest]!)) {
				highest = left
			}

			if (right < size && this.#isHigherPriority(this.#heap[right]!, this.#heap[highest]!)) {
				highest = right
			}

			if (highest === parent) {
				return
			}

			let tmp = this.#heap[parent]!
			this.#heap[parent] = this.#heap[highest]!
			this.#heap[highest] = tmp
			parent = highest
		}
	}

	#isHigherPriority(left: PriorityNode<T>, right: PriorityNode<T>): boolean {
		if (left.priority !== right.priority) {
			return left.priority > right.priority
		}

		return left.sequence < right.sequence
	}
}
