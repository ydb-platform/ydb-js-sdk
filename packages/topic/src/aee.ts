import { EventEmitter } from 'events';

export class AsyncEventEmitter<T> implements Disposable, AsyncIterable<T> {
	private emitter: EventEmitter;
	private eventName: string;
	private queue: Array<T> = [];
	private resolvers: Array<(value: IteratorResult<T>) => void> = [];
	private rejecters: Array<(err: any) => void> = [];
	private ended = false;
	private error: any = null;

	constructor(emitter: EventEmitter, eventName: string) {
		this.emitter = emitter;
		this.eventName = eventName;

		this.emitter.on(this.eventName, (data: T) => {
			if (this.resolvers.length > 0) {
				const resolve = this.resolvers.shift()!;
				resolve({ value: data, done: false });
			} else {
				this.queue.push(data);
			}
		});

		this.emitter.once('end', () => {
			this.ended = true;
			while (this.resolvers.length > 0) {
				const resolve = this.resolvers.shift()!;
				resolve({ value: undefined, done: true });
			}
		});

		this.emitter.once('error', (err: any) => {
			this.error = err;
			while (this.rejecters.length > 0) {
				const reject = this.rejecters.shift()!;
				reject(err);
			}
			while (this.resolvers.length > 0) {
				const reject = this.rejecters.shift();
				if (reject) reject(err);
			}
		});
	}

	next(): Promise<IteratorResult<T>> {
		if (this.error) {
			return Promise.reject(this.error);
		}
		if (this.queue.length > 0) {
			return Promise.resolve({ value: this.queue.shift()!, done: false });
		}
		if (this.ended) {
			return Promise.resolve({ value: undefined, done: true });
		}
		return new Promise<IteratorResult<T>>((resolve, reject) => {
			this.resolvers.push(resolve);
			this.rejecters.push(reject);
		});
	}

	return(): Promise<IteratorResult<T>> {
		this.ended = true;
		while (this.resolvers.length > 0) {
			const resolve = this.resolvers.shift()!;
			resolve({ value: undefined, done: true });
		}
		return Promise.resolve({ value: undefined, done: true });
	}

	throw(err?: any): Promise<IteratorResult<T>> {
		this.error = err;
		while (this.rejecters.length > 0) {
			const reject = this.rejecters.shift()!;
			reject(err);
		}
		while (this.resolvers.length > 0) {
			const reject = this.rejecters.shift();
			if (reject) reject(err);
		}
		return Promise.resolve({ value: undefined, done: true });
	}

	[Symbol.asyncIterator]() {
		return this;
	}

	dispose(): void {
		this.emitter.removeAllListeners(this.eventName);
		this.emitter.removeAllListeners('end');
		this.emitter.removeAllListeners('error');
		this.resolvers.length = 0;
		this.rejecters.length = 0;
		this.queue.length = 0;
		this.ended = true;
		this.error = null;
	}

	[Symbol.dispose](): void {
		this.dispose();
	}
}
