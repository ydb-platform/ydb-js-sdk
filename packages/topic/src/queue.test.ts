import { describe, expect, it } from 'vitest';
import { PQueue } from './queue.ts';

describe('PQueue', () => {
	it('should process items in priority order', async () => {
		const queue = new PQueue<number>();

		queue.push(1, 1); // Priority 1
		queue.push(2, 3); // Priority 3
		queue.push(3, 2); // Priority 2

		expect(await queue.shift()).toBe(2); // Highest priority
		expect(await queue.shift()).toBe(3); // Next highest priority
		expect(await queue.shift()).toBe(1); // Lowest priority
	});

	it('should handle async iteration', async () => {
		const queue = new PQueue<number>();

		queue.push(1, 1);
		queue.push(2, 2);
		queue.push(3, 3);

		const results: number[] = [];
		for await (const item of queue) {
			results.push(item);
			if (results.length === 3) break;
		}

		expect(results).toEqual([3, 2, 1]);
	});

	it('should resolve pending shifts when items are added', async () => {
		const queue = new PQueue<number>();

		const shiftPromise = queue.shift();
		queue.push(42, 1);

		expect(await shiftPromise).toBe(42);
	});

	it('should throw an error when pushing to a closed queue', () => {
		const queue = new PQueue<number>();
		queue.close();

		expect(() => queue.push(1)).toThrow('Queue closed');
	});

	it('should throw an error when shifting from a closed queue', async () => {
		const queue = new PQueue<number>();
		queue.close();

		await expect(queue.shift()).rejects.toThrow('Queue closed');
	});
});
