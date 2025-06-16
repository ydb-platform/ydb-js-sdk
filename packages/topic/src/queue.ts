export class PQueue<T> implements AsyncIterable<T>, Disposable {
	private closed = false;
	private readonly heap: { value: T; priority: number }[] = [];
	private readonly pendingShifts: ((value: IteratorResult<T>) => void)[] = [];
	private readonly pendingRejects: ((reason?: any) => void)[] = [];

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

		if (this.pendingShifts.length > 0) {
			this.pendingRejects.shift()!;
			let next = this.heap.shift()!;
			let resolve = this.pendingShifts.shift()!;
			resolve({ value: next.value, done: false });
		}
	}

	async shift(): Promise<T> {
		if (this.closed && this.heap.length === 0) {
			throw new Error('Queue closed');
		}

		if (this.heap.length > 0) {
			let next = this.heap.shift()!;
			return next.value;
		}

		return new Promise<T>((resolve, reject) => {
			this.pendingRejects.push(reject);
			this.pendingShifts.push(({ value, done }) => {
				if (done) {
					reject(new Error('Queue closed'));
				} else {
					resolve(value);
				}
			});
		});
	}

	close() {
		this.closed = true;
		while (this.pendingShifts.length > 0) {
			this.pendingRejects.shift()!;
			let resolve = this.pendingShifts.shift()!;
			resolve({ value: undefined as any, done: true });
		}
	}

	restartConsumer() {
		while (this.pendingShifts.length > 0) {
			this.pendingShifts.shift()!;
			let reject = this.pendingRejects.shift()!;
			reject(new Error('Consumer restarted'));
		}
	}

	async next(): Promise<IteratorResult<T>> {
		if (this.closed && this.heap.length === 0) {
			return { value: undefined as any, done: true };
		}

		if (this.heap.length > 0) {
			let next = this.heap.shift()!;
			return { value: next.value, done: false };
		}

		return new Promise<IteratorResult<T>>((resolve, reject) => {
			this.pendingShifts.push(resolve);
			this.pendingRejects.push(reject);
		});
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
		this.close();
		this.heap.length = 0;
		this.pendingShifts.length = 0;
		this.pendingRejects.length = 0;
	}
}
