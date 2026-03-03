import { afterAll, expect, inject, test } from 'vitest'

import { Driver } from '@ydbjs/core'
import { coordination } from '../src/index.js'

let driver = new Driver(inject('connectionString'), {
	'ydb.sdk.enable_discovery': false,
})
await driver.ready()

let client = coordination(driver)
let testNodePath = '/local/test-coordination-memory'

await client.createNode(testNodePath)

afterAll(async () => {
	await client.dropNode(testNodePath)
})

// oxlint-disable-next-line
test.skip(
	'creating and closing sessions does not leak memory',
	{ timeout: 900_000 },
	async () => {
		let iterations = 50_000
		let memoryBefore = process.memoryUsage().heapUsed

		for (let i = 0; i < iterations; i++) {
			// oxlint-disable-next-line no-await-in-loop
			let session = await client.session(testNodePath)
			// oxlint-disable-next-line no-await-in-loop
			await session.close()

			if (i % 1000 === 0 && i > 0) {
				if (global.gc) {
					global.gc()
				}
			}
		}

		if (global.gc) {
			global.gc()
		}

		let memoryAfter = process.memoryUsage().heapUsed
		let memoryGrowth = memoryAfter - memoryBefore
		let memoryGrowthMB = memoryGrowth / (1024 * 1024)

		expect(memoryGrowthMB).toBeLessThan(50)
	}
)

// oxlint-disable-next-line
test.skip(
	'creating and disposing sessions with using does not leak memory',
	{ timeout: 900_000 },
	async () => {
		let iterations = 50_000
		let memoryBefore = process.memoryUsage().heapUsed

		for (let i = 0; i < iterations; i++) {
			// oxlint-disable-next-line no-await-in-loop
			await using _session = await client.session(testNodePath)

			if (i % 1000 === 0 && i > 0) {
				if (global.gc) {
					global.gc()
				}
			}
		}

		if (global.gc) {
			global.gc()
		}

		let memoryAfter = process.memoryUsage().heapUsed
		let memoryGrowth = memoryAfter - memoryBefore
		let memoryGrowthMB = memoryGrowth / (1024 * 1024)

		expect(memoryGrowthMB).toBeLessThan(50)
	}
)

// oxlint-disable-next-line
test.skip(
	'acquiring and releasing locks does not leak memory',
	{ timeout: 900_000 },
	async () => {
		let iterations = 50_000
		let memoryBefore = process.memoryUsage().heapUsed

		await using session = await client.session(testNodePath)

		for (let i = 0; i < iterations; i++) {
			// oxlint-disable-next-line no-await-in-loop
			let lock = await session.acquire(`test-lock-${i % 100}`, {
				count: 1,
				ephemeral: true,
			})
			// oxlint-disable-next-line no-await-in-loop
			await lock.release()

			if (i % 1000 === 0 && i > 0) {
				if (global.gc) {
					global.gc()
				}
			}
		}

		if (global.gc) {
			global.gc()
		}

		let memoryAfter = process.memoryUsage().heapUsed
		let memoryGrowth = memoryAfter - memoryBefore
		let memoryGrowthMB = memoryGrowth / (1024 * 1024)

		expect(memoryGrowthMB).toBeLessThan(50)
	}
)

// oxlint-disable-next-line
test.skip(
	'acquiring and disposing locks with using does not leak memory',
	{ timeout: 900_000 },
	async () => {
		let iterations = 50_000
		let memoryBefore = process.memoryUsage().heapUsed

		await using session = await client.session(testNodePath)

		for (let i = 0; i < iterations; i++) {
			// oxlint-disable-next-line no-await-in-loop
			await using _lock = await session.acquire(`test-lock-${i % 100}`, {
				count: 1,
				ephemeral: true,
			})

			if (i % 1000 === 0 && i > 0) {
				if (global.gc) {
					global.gc()
				}
			}
		}

		if (global.gc) {
			global.gc()
		}

		let memoryAfter = process.memoryUsage().heapUsed
		let memoryGrowth = memoryAfter - memoryBefore
		let memoryGrowthMB = memoryGrowth / (1024 * 1024)

		expect(memoryGrowthMB).toBeLessThan(50)
	}
)

// oxlint-disable-next-line
test.skip(
	'acquireLock with session management does not leak memory',
	{ timeout: 900_000 },
	async () => {
		let iterations = 50_000
		let memoryBefore = process.memoryUsage().heapUsed

		for (let i = 0; i < iterations; i++) {
			// oxlint-disable-next-line no-await-in-loop
			await using _lock = await client.acquireLock(
				testNodePath,
				`test-lock-${i % 100}`,
				{
					count: 1,
					ephemeral: true,
				}
			)

			if (i % 1000 === 0 && i > 0) {
				if (global.gc) {
					global.gc()
				}
			}
		}

		if (global.gc) {
			global.gc()
		}

		let memoryAfter = process.memoryUsage().heapUsed
		let memoryGrowth = memoryAfter - memoryBefore
		let memoryGrowthMB = memoryGrowth / (1024 * 1024)

		expect(memoryGrowthMB).toBeLessThan(50)
	}
)

// oxlint-disable-next-line
test.skip(
	'withLock callback style does not leak memory',
	{ timeout: 900_000 },
	async () => {
		let iterations = 50_000
		let memoryBefore = process.memoryUsage().heapUsed

		for (let i = 0; i < iterations; i++) {
			// oxlint-disable-next-line no-await-in-loop
			await client.withLock(
				testNodePath,
				`test-lock-${i % 100}`,
				async (signal) => {
					// Simulate some work
					return signal.aborted
				},
				{
					count: 1,
					ephemeral: true,
				}
			)

			if (i % 1000 === 0 && i > 0) {
				if (global.gc) {
					global.gc()
				}
			}
		}

		if (global.gc) {
			global.gc()
		}

		let memoryAfter = process.memoryUsage().heapUsed
		let memoryGrowth = memoryAfter - memoryBefore
		let memoryGrowthMB = memoryGrowth / (1024 * 1024)

		expect(memoryGrowthMB).toBeLessThan(50)
	}
)

// oxlint-disable-next-line
test.skip(
	'watching semaphores does not leak memory',
	{ timeout: 900_000 },
	async () => {
		let iterations = 50_000
		let memoryBefore = process.memoryUsage().heapUsed

		await using session = await client.session(testNodePath)

		await session.create('test-watch-semaphore', {
			limit: 10,
		})

		for (let i = 0; i < iterations; i++) {
			// oxlint-disable-next-line no-await-in-loop
			for await (let _changed of session.watch('test-watch-semaphore', {
				data: true,
			})) {
				break
			}

			if (i % 100 === 0 && i > 0) {
				if (global.gc) {
					global.gc()
				}
			}
		}

		await session.delete('test-watch-semaphore')

		if (global.gc) {
			global.gc()
		}

		let memoryAfter = process.memoryUsage().heapUsed
		let memoryGrowth = memoryAfter - memoryBefore
		let memoryGrowthMB = memoryGrowth / (1024 * 1024)

		expect(memoryGrowthMB).toBeLessThan(50)
	}
)

// oxlint-disable-next-line
test.skip(
	'election participation does not leak memory',
	{ timeout: 900_000 },
	async () => {
		let iterations = 50_000
		let memoryBefore = process.memoryUsage().heapUsed

		for (let i = 0; i < iterations; i++) {
			// oxlint-disable-next-line no-await-in-loop
			for await (let _leader of client.election(
				testNodePath,
				`test-election-${i % 10}`,
				{
					data: new TextEncoder().encode(`node-${i}`),
					ephemeral: true,
				}
			)) {
				break
			}

			if (i % 100 === 0 && i > 0) {
				if (global.gc) {
					global.gc()
				}
			}
		}

		if (global.gc) {
			global.gc()
		}

		let memoryAfter = process.memoryUsage().heapUsed
		let memoryGrowth = memoryAfter - memoryBefore
		let memoryGrowthMB = memoryGrowth / (1024 * 1024)

		expect(memoryGrowthMB).toBeLessThan(50)
	}
)
