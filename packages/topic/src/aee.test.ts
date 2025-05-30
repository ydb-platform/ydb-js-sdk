import { expect, test } from 'vitest';
import { EventEmitter } from 'node:events';

import { AsyncEventEmitter } from './aee.ts';


test('AsyncEventEmitter yields events as they are emitted', async () => {
	let emitter = new EventEmitter();
	let asyncEmitter = new AsyncEventEmitter<number>(emitter, 'data');
	let results: number[] = [];

	setTimeout(() => {
		emitter.emit('data', 1);
		emitter.emit('data', 2);
		emitter.emit('end');
	}, 0);

	for await (let value of asyncEmitter) {
		results.push(value);
	}

	expect(results).toEqual([1, 2]);
});

test('AsyncEventEmitter handles errors emitted by the emitter', async () => {
	let emitter = new EventEmitter();
	let asyncEmitter = new AsyncEventEmitter<number>(emitter, 'data');
	let iter = asyncEmitter[Symbol.asyncIterator]();

	setTimeout(() => {
		emitter.emit('data', 1);
		emitter.emit('error', new Error('fail'));
	}, 0);

	await expect(iter.next()).resolves.toEqual({ value: 1, done: false });
	await expect(iter.next()).rejects.toThrow('fail');
});

test('AsyncEventEmitter can be manually closed with return()', async () => {
	let emitter = new EventEmitter();
	let asyncEmitter = new AsyncEventEmitter<number>(emitter, 'data');
	let iter = asyncEmitter[Symbol.asyncIterator]();

	setTimeout(() => {
		emitter.emit('data', 1);
	}, 0);

	await expect(iter.next()).resolves.toEqual({ value: 1, done: false });
	await expect(iter.return!()).resolves.toEqual({ value: undefined, done: true });
});

test('AsyncEventEmitter can be manually closed with throw()', async () => {
	let emitter = new EventEmitter();
	let asyncEmitter = new AsyncEventEmitter<number>(emitter, 'data');
	let iter = asyncEmitter[Symbol.asyncIterator]();

	setTimeout(() => {
		emitter.emit('data', 1);
	}, 0);

	await expect(iter.next()).resolves.toEqual({ value: 1, done: false });
	await expect(iter.throw!(new Error('manual'))).resolves.toEqual({ value: undefined, done: true });
});
