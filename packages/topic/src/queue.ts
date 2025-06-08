export class PQueue<T> implements AsyncIterable<T>, Disposable {
	private queue: { value: T; priority: number }[] = [];
	private closed = false;
	private resolvers: ((value: T) => void)[] = [];

	push(value: T, priority: number = 0) {
		if (this.closed) throw new Error("Queue closed");

		let item = { value, priority };
		let inserted = false;

		for (let i = 0; i < this.queue.length; i++) {
			if (this.queue[i].priority < priority) {
				this.queue.splice(i, 0, item);
				inserted = true;
				break;
			}
		}

		if (!inserted) {
			this.queue.push(item);
		}

		if (this.resolvers.length) {
			const nextItem = this.queue.shift()!;
			this.resolvers.shift()?.(nextItem.value);
		}
	}

	async shift(): Promise<T> {
		if (this.queue.length) {
			return this.queue.shift()!.value;
		}
		if (this.closed) throw new Error("Queue closed");
		return new Promise<T>((resolve) => {
			this.resolvers.push(resolve);
		});
	}

	close() {
		this.closed = true;
		while (this.resolvers.length) {
			this.resolvers.shift()?.(undefined as any);
		}
	}

	async next(): Promise<IteratorResult<T>> {
		try {
			return { value: await this.shift(), done: false };
		} catch {
			return { value: undefined, done: true };
		}
	}

	[Symbol.asyncIterator]() {
		return this;
	}

	[Symbol.dispose]() {
		this.close();
		this.queue.length = 0;
		this.resolvers.length = 0;
	}
}
