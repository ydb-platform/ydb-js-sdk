export class AsyncPriorityQueue<T> implements AsyncIterable<T>, Disposable {
	private paused = false;
	private closed = false;
	private readonly heap: { value: T; priority: number }[] = [];
	private pendingShift?: (value: IteratorResult<T>) => void;
	private pendingResume?: () => void;

	get size(): number {
		return this.heap.length;
	}

	push(value: T, priority: number = 0) {
		if (this.closed) {
			throw new Error('Queue closed');
		}

		let left = 0;
		let right = this.heap.length;
		while (left < right) {
			let mid = (left + right) >> 1;
			if (this.heap[mid].priority < priority) {
				right = mid;
			} else {
				left = mid + 1;
			}
		}

		this.heap.splice(left, 0, { value, priority });

		if (this.pendingShift && this.heap.length > 0) {
			const next = this.heap.shift()!;
			const resolve = this.pendingShift;
			this.pendingShift = undefined;
			resolve({ value: next.value, done: false });
		}
	}

	private async next(): Promise<IteratorResult<T>> {
		if (this.paused) {
			await new Promise<void>(resolve => {
				this.pendingResume = resolve;
			});
		}

		// Return done if closed and no items to process
		if (this.closed && this.heap.length === 0) {
			return { value: undefined as any, done: true };
		}

		if (this.heap.length > 0) {
			let next = this.heap.shift()!;
			return { value: next.value, done: false };
		}

		// If we reach here: not closed and no items in heap
		// Create pending operation to wait for new items
		return new Promise<IteratorResult<T>>((resolve) => {
			this.pendingShift = resolve;
		});
	}

	pause() {
		this.paused = true;
	}

	resume() {
		if (!this.paused) return;
		this.paused = false;
		if (this.pendingResume) {
			const resolve = this.pendingResume;
			this.pendingResume = undefined;
			resolve();
		}
	}

	close() {
		this.closed = true;
		// Resolve any pending operations with done: true
		if (this.pendingShift) {
			this.pendingShift({ value: undefined as any, done: true });
			this.pendingShift = undefined;
		}
		if (this.pendingResume) {
			this.pendingResume();
			this.pendingResume = undefined;
		}
	}

	dispose() {
		// Clear the heap to prevent memory leaks
		this.heap.length = 0;
		// Close and resolve pending operations
		this.close();
	}

	async *[Symbol.asyncIterator]() {
		while (true) {
			// eslint-disable-next-line no-await-in-loop
			let { value, done } = await this.next();
			if (done) break;
			yield value;
		}
	}

	[Symbol.dispose]() {
		this.dispose();
	}
}
