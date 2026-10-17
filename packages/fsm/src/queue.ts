type QueueFailure = { error: unknown }
type ShiftResult<T> = IteratorResult<T> & { failure?: QueueFailure }
type ShiftResolver<T> = (value: ShiftResult<T>) => void
type ResumeCompletion = { failure: QueueFailure | null }
type ResumeResolver = (completion: ResumeCompletion | undefined) => void

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
	#generation = 0

	// Set by fail() so the iterator throws this error once the buffer drains,
	// instead of ending silently. Lets a producer terminate the stream with a
	// reason without wrapping the iterator (which would tax every happy-path item).
	#failure: QueueFailure | null = null

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
		this.#resolvePendingResume(this.getBufferSize() === 0)
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
		this.#failure = null
		this.#closed = true
		this.#paused = false
		this.clearBuffer()
		this.#resolvePendingResume(true)
		this.#resolvePendingDone()
	}

	reset(): void {
		this.#generation += 1
		this.#paused = false
		this.#closed = false
		this.#destroyed = false
		this.#failure = null
		this.clearBuffer()
		this.#resolvePendingResume(true)
		this.#resolvePendingDone()
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		let generation = this.#generation
		while (generation === this.#generation) {
			// oxlint-disable-next-line no-await-in-loop
			let next: ShiftResult<T> | undefined = await this.#next(generation)
			if (next.done) {
				if (next.failure) {
					throw next.failure.error
				}

				return
			}

			yield next.value
			// Do not retain the delivered payload while waiting for another item.
			next = undefined
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
		let generation = this.#generation
		for (;;) {
			signal?.throwIfAborted()
			if (this.#destroyed || generation !== this.#generation) {
				return { value: undefined as never, done: true }
			}

			if (this.#paused) {
				// Wait for resume(), then re-evaluate from the top.
				// oxlint-disable-next-line no-await-in-loop
				let completion = await this.#parkCancellable(this.#pendingResume, signal)
				if (completion !== undefined) {
					if (completion.failure) {
						throw completion.failure.error
					}
					return { value: undefined as never, done: true }
				}
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
			if (result.done && result.failure) {
				throw result.failure.error
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

	async #next(generation: number): Promise<ShiftResult<T>> {
		if (this.#destroyed || generation !== this.#generation) {
			return { value: undefined as never, done: true }
		}

		while (this.#paused) {
			// oxlint-disable-next-line no-await-in-loop
			let completion = await this.#waitForResume()
			if (completion?.failure) {
				return { value: undefined as never, done: true, failure: completion.failure }
			}
			if (completion !== undefined || this.#destroyed || generation !== this.#generation) {
				return { value: undefined as never, done: true }
			}
		}

		let item = this.dequeue()
		if (item.hasValue) {
			return { value: item.value, done: false }
		}

		if (this.#closed || this.#destroyed) {
			return this.#failure
				? { value: undefined as never, done: true, failure: this.#failure }
				: { value: undefined as never, done: true }
		}

		return new Promise<ShiftResult<T>>((resolve) => {
			this.#pendingShift.push(resolve)
		})
	}

	#waitForResume(): Promise<ResumeCompletion | undefined> {
		if (!this.#paused || this.#destroyed) {
			return Promise.resolve(undefined)
		}

		return new Promise<ResumeCompletion | undefined>((resolve) => {
			this.#pendingResume.push(resolve)
		})
	}

	#resolvePendingResume(done = false): void {
		if (this.#pendingResume.length === 0) {
			return
		}
		// Capture terminal completion before resumed waiters can observe a later abort.
		let completion = done ? { failure: this.#failure } : undefined
		while (this.#pendingResume.length > 0) {
			let resolve = this.#pendingResume.shift()!
			resolve(completion)
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
			resolve(
				this.#failure
					? { value: undefined as never, done: true, failure: this.#failure }
					: { value: undefined as never, done: true }
			)
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
