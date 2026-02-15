import { expect, inject, test } from 'vitest'
import { setTimeout as sleep } from 'node:timers/promises'

import { Driver } from '@ydbjs/core'
import { YDBError } from '@ydbjs/error'

import { CoordinationSessionEvents, coordination } from '../src/index.js'
import { type SemaphoreChangedEvent, TEST_ONLY } from '../src/session.js'

let driver = new Driver(inject('connectionString'), {
	'ydb.sdk.enable_discovery': false,
})

let client = coordination(driver)

async function createCoordinationNode(path: string): Promise<void> {
	await client.createNode(path)
}

async function dropCoordinationNode(path: string): Promise<void> {
	await client.dropNode(path)
}

test(
	'creates session and acquires semaphore with ephemeral',
	{ timeout: 30000 },
	async () => {
		let nodePath = '/local/test-node-1'
		await createCoordinationNode(nodePath)

		let session = await client.session(nodePath)

		try {
			// Acquire ephemeral semaphore (created automatically)
			let semaphore = await session.acquire('test-lock', {
				count: 1,
				ephemeral: true,
			})
			expect(semaphore.name).toBe('test-lock')

			// Release semaphore (deleted automatically)
			await session.release('test-lock')
		} finally {
			await session.close()
			await dropCoordinationNode(nodePath)
		}
	}
)

test(
	'creates session and acquires semaphore with explicit create',
	{ timeout: 30000 },
	async () => {
		let nodePath = '/local/test-node-1b'
		await createCoordinationNode(nodePath)

		let session = await client.session(nodePath)

		try {
			await session.create('test-lock', { limit: 1 })

			let semaphore = await session.acquire('test-lock', { count: 1 })
			expect(semaphore.name).toBe('test-lock')

			await session.release('test-lock')

			await session.delete('test-lock')
		} finally {
			await session.close()
			await dropCoordinationNode(nodePath)
		}
	}
)

test('creates semaphore with initial count', { timeout: 30000 }, async () => {
	let nodePath = '/local/test-node-2'
	await createCoordinationNode(nodePath)

	let session = await client.session(nodePath)

	try {
		await session.create('test-semaphore', { limit: 5 })

		let { description } = await session.describe('test-semaphore')
		expect(description!.count).toBe(0n) // 0 tokens acquired
		expect(description!.limit).toBe(5n) // limit is 5

		await session.delete('test-semaphore')
	} finally {
		await session.close()
		await dropCoordinationNode(nodePath)
	}
})

test('updates semaphore data', { timeout: 30000 }, async () => {
	let nodePath = '/local/test-node-3'
	await createCoordinationNode(nodePath)

	let session = await client.session(nodePath)

	try {
		await session.create('test-semaphore', {
			limit: 3,
			data: new Uint8Array([1, 2, 3]),
		})

		await session.update('test-semaphore', new Uint8Array([4, 5, 6]))

		let { description } = await session.describe('test-semaphore')
		expect(Array.from(description!.data)).toEqual([4, 5, 6])

		await session.delete('test-semaphore')
	} finally {
		await session.close()
		await dropCoordinationNode(nodePath)
	}
})

test('multiple clients compete for semaphore', { timeout: 30000 }, async () => {
	let nodePath = '/local/test-node-4'
	await createCoordinationNode(nodePath)

	let session1 = await client.session(nodePath)
	let session2 = await client.session(nodePath)

	try {
		// Create semaphore with limit 1
		await session1.create('exclusive-lock', { limit: 1 })

		// Session 1 acquires
		let semaphore1 = await session1.acquire('exclusive-lock', { count: 1 })
		expect(semaphore1.name).toBe('exclusive-lock')

		// Session 2 tries to acquire with timeout (should throw YDBError)
		await expect(
			session2.acquire('exclusive-lock', {
				count: 1,
				timeoutMillis: 100,
			})
		).rejects.toThrow(YDBError)

		// Session 1 releases
		await session1.release('exclusive-lock')

		// Session 2 can now acquire
		let semaphore3 = await session2.acquire('exclusive-lock', { count: 1 })
		expect(semaphore3.name).toBe('exclusive-lock')

		await session2.release('exclusive-lock')
		await session1.delete('exclusive-lock')
	} finally {
		await session1.close()
		await session2.close()
		await dropCoordinationNode(nodePath)
	}
})

test('close rejects pending requests', { timeout: 30000 }, async () => {
	let nodePath = '/local/test-node-6'
	await createCoordinationNode(nodePath)

	let session1 = await client.session(nodePath)
	let session2 = await client.session(nodePath)

	try {
		await session1.create('test-lock', { limit: 1 })

		await session1.acquire('test-lock', { count: 1 })

		// Session 2 tries to acquire (will wait indefinitely)
		let acquirePromise = session2.acquire('test-lock', { count: 1 })

		// Wait a bit to ensure request is sent and pending
		await sleep(100)

		// Close session 2 - should reject pending request
		await session2.close()

		await expect(acquirePromise).rejects.toThrow('Stream closed')

		await session1.release('test-lock')
		await session1.delete('test-lock')
	} finally {
		await session1.close()
		await dropCoordinationNode(nodePath)
	}
})

test('multiple operations in sequence', { timeout: 30000 }, async () => {
	let nodePath = '/local/test-node-8'
	await createCoordinationNode(nodePath)

	let session = await client.session(nodePath)

	try {
		await session.create('sem1', { limit: 2 })
		await session.create('sem2', { limit: 3 })

		let semaphore1 = await session.acquire('sem1', { count: 1 })
		let semaphore2 = await session.acquire('sem2', { count: 2 })
		expect(semaphore1.name).toBe('sem1')
		expect(semaphore2.name).toBe('sem2')

		let { description: desc1 } = await session.describe('sem1')
		let { description: desc2 } = await session.describe('sem2')

		expect(desc1!.count).toBe(1n)
		expect(desc2!.count).toBe(2n)

		await session.release('sem1')
		await session.release('sem2')

		await session.delete('sem1')
		await session.delete('sem2')
	} finally {
		await session.close()
		await dropCoordinationNode(nodePath)
	}
})

test(
	'reconnects and retries pending requests after disconnection',
	{ timeout: 30000 },
	async () => {
		let nodePath = '/local/test-node-9'
		await createCoordinationNode(nodePath)

		let session1 = await client.session(nodePath)
		let session2 = await client.session(nodePath)

		try {
			let session1IdBefore = session1.sessionId
			let session2IdBefore = session2.sessionId

			await session1.create('exclusive-lock', { limit: 1 })

			await session1.acquire('exclusive-lock', { count: 1 })

			// Session 2 tries to acquire (will be pending because session1 holds it)
			let pendingSemaphore = session2.acquire('exclusive-lock', {
				count: 1,
			})

			// Wait to ensure request is sent and becomes pending on server
			await sleep(100)

			// Describe with owners and waiters
			let { description } = await session1.describe('exclusive-lock', {
				includeOwners: true,
				includeWaiters: true,
			})

			expect(description!.count).toBe(1n)
			expect(description!.limit).toBe(1n)
			expect(description!.owners).toBeDefined()
			expect(description!.owners.length).toBe(1)
			expect(description!.owners[0]!.sessionId).toBe(session1.sessionId)
			expect(description!.owners[0]!.count).toBe(1n)
			expect(description!.waiters).toBeDefined()
			expect(description!.waiters.length).toBe(1)
			expect(description!.waiters[0]!.sessionId).toBe(session2.sessionId)
			expect(description!.waiters[0]!.count).toBe(1n)

			session2[TEST_ONLY]().forceReconnect()

			// Session 1 sends request to release the lock
			session1.release('exclusive-lock')

			// Wait to ensure request is sent and becomes pending on client
			await sleep(100)

			// Session 2's pending request should be retried after reconnect
			// and should succeed now that session 1 released the lock
			let semaphore = await pendingSemaphore
			expect(semaphore.name).toBe('exclusive-lock')

			// Describe with owners and waiters
			let { description: newDescription } = await session2.describe(
				'exclusive-lock',
				{ includeOwners: true, includeWaiters: true }
			)

			expect(newDescription!.count).toBe(1n)
			expect(newDescription!.limit).toBe(1n)
			expect(newDescription!.owners).toBeDefined()
			expect(newDescription!.owners.length).toBe(1)
			expect(newDescription!.owners[0]!.sessionId).toBe(
				session2.sessionId
			)
			expect(newDescription!.owners[0]!.count).toBe(1n)

			// Verify session IDs are preserved (session recovery)
			expect(session1.sessionId).toBe(session1IdBefore)
			expect(session2.sessionId).toBe(session2IdBefore)

			await session2.release('exclusive-lock')
			await session1.delete('exclusive-lock')
		} finally {
			await session1.close()
			await session2.close()
			await dropCoordinationNode(nodePath)
		}
	}
)

test(
	'multiple sessions compete for limited semaphore',
	{ timeout: 30000 },
	async () => {
		let nodePath = '/local/test-node-10'
		await createCoordinationNode(nodePath)

		let sessions = await Promise.all([
			client.session(nodePath),
			client.session(nodePath),
			client.session(nodePath),
			client.session(nodePath),
			client.session(nodePath),
		])

		try {
			await sessions[0].create('limited-resource', { limit: 2 })

			let acquirePromises = sessions.map((session) =>
				session.tryAcquire('limited-resource', {
					count: 1,
					timeoutMillis: 500,
				})
			)

			let results = await Promise.all(acquirePromises)
			let acquiredCount = results.filter(
				(semaphore) => semaphore !== null
			).length
			// Only 2 should have acquired (others timed out)
			expect(acquiredCount).toBe(2)

			for (let i = 0; i < sessions.length; i++) {
				if (results[i] && sessions[i]) {
					// eslint-disable-next-line no-await-in-loop
					await sessions[i]!.release('limited-resource')
				}
			}

			await sessions[0].delete('limited-resource')
		} finally {
			await Promise.all(sessions.map((s) => s.close()))
			await dropCoordinationNode(nodePath)
		}
	}
)

test('watch semaphore changes', { timeout: 30000 }, async () => {
	let nodePath = '/local/test-node-14'
	await createCoordinationNode(nodePath)

	let session = await client.session(nodePath)

	try {
		await session.create('watched-sem', {
			limit: 1,
			data: new Uint8Array([1, 2, 3]),
		})

		let changedEvents: SemaphoreChangedEvent[] = []
		session.on(
			CoordinationSessionEvents.SEMAPHORE_CHANGED,
			(event: SemaphoreChangedEvent) => {
				changedEvents.push(event)
			}
		)

		// Describe with watch enabled
		let desc = await session.describe('watched-sem', {
			watchData: true,
			watchOwners: true,
		})
		expect(desc).toBeDefined()

		// Update semaphore data - should trigger change event
		await session.update('watched-sem', new Uint8Array([4, 5, 6]))

		await sleep(100)

		// Verify event was emitted
		expect(changedEvents.length).toBeGreaterThan(0)
		expect(changedEvents[0]?.name).toBe('watched-sem')
		expect(changedEvents[0]?.dataChanged).toBe(true)

		await session.delete('watched-sem')
	} finally {
		await session.close()
		await dropCoordinationNode(nodePath)
	}
})

test('rejects request on operation error', { timeout: 30000 }, async () => {
	let nodePath = '/local/test-node-15'
	await createCoordinationNode(nodePath)

	let session = await client.session(nodePath)

	try {
		// Try to acquire non-existent semaphore without ephemeral flag
		await expect(
			session.acquire('non-existent-sem', { count: 1, ephemeral: false })
		).rejects.toThrow(YDBError)

		// Try to delete non-existent semaphore
		await expect(session.delete('non-existent-sem')).rejects.toThrow(
			YDBError
		)

		// Try to update non-existent semaphore
		await expect(
			session.update('non-existent-sem', new Uint8Array([1, 2, 3]))
		).rejects.toThrow(YDBError)

		// Try to describe non-existent semaphore
		await expect(session.describe('non-existent-sem')).rejects.toThrow(
			YDBError
		)
	} finally {
		await session.close()
		await dropCoordinationNode(nodePath)
	}
})

test(
	'resets sessionId to 0 on SESSION_EXPIRED failure',
	{ timeout: 30000 },
	async () => {
		let nodePath = '/local/test-node-16'
		await createCoordinationNode(nodePath)

		// Create session with very short timeout
		let session = await client.session(nodePath, { recoveryWindowMs: 1 })

		try {
			let initialSessionId = session.sessionId
			expect(initialSessionId).toBeGreaterThan(0n)

			let semaphore = await session.acquire('test-sem', {
				ephemeral: true,
			})
			expect(semaphore.name).toBe('test-sem')

			// Force disconnect to simulate network issue
			session[TEST_ONLY]().forceReconnect()

			await sleep(100)

			// Session expired, so semaphore from old session won't exist
			await expect(session.describe('test-sem')).rejects.toThrow(YDBError)

			// After reconnection with SESSION_EXPIRED, sessionId should be different
			// (new session was created because old one expired)
			let newSessionId = session.sessionId
			expect(newSessionId).toBeGreaterThan(0n)
			expect(newSessionId).not.toBe(initialSessionId)
		} finally {
			await session.close()
			await dropCoordinationNode(nodePath)
		}
	}
)

test(
	'aborts semaphore operation with AbortSignal timeout',
	{ timeout: 30000 },
	async () => {
		let nodePath = '/local/test-node-17'
		await createCoordinationNode(nodePath)

		let session1 = await client.session(nodePath)
		let session2 = await client.session(nodePath)

		try {
			await session1.create('exclusive-lock', { limit: 1 })
			await session1.acquire('exclusive-lock', { count: 1 })

			// Session2 tries to acquire with short timeout - will be pending and then abort
			await expect(
				session2.acquire(
					'exclusive-lock',
					{ count: 1 },
					AbortSignal.timeout(1)
				)
			).rejects.toThrow('AbortError')

			await session1.release('exclusive-lock')
		} finally {
			await session1.close()
			await session2.close()
			await dropCoordinationNode(nodePath)
		}
	}
)

test(
	'automatically releases semaphore with using keyword',
	{ timeout: 30000 },
	async () => {
		let nodePath = '/local/test-node-using-4'
		await createCoordinationNode(nodePath)

		await using session = await client.session(nodePath)

		await session.create('sem1', { limit: 1 })
		await session.create('sem2', { limit: 1 })

		{
			await using lock1 = await session.acquire('sem1', { count: 1 })
			expect(lock1.name).toBe('sem1')

			{
				await using lock2 = await session.acquire('sem2', { count: 1 })
				expect(lock2.name).toBe('sem2')

				let desc1 = await session.describe('sem1')
				let desc2 = await session.describe('sem2')
				expect(desc1.description!.count).toBe(1n)
				expect(desc2.description!.count).toBe(1n)
			}

			let desc1 = await session.describe('sem1')
			let desc2 = await session.describe('sem2')
			expect(desc1.description!.count).toBe(1n)
			expect(desc2.description!.count).toBe(0n)
		}

		let desc1 = await session.describe('sem1')
		let desc2 = await session.describe('sem2')
		expect(desc1.description!.count).toBe(0n)
		expect(desc2.description!.count).toBe(0n)

		await session.delete('sem1')
		await session.delete('sem2')

		await dropCoordinationNode(nodePath)
	}
)

test('semaphore update and describe methods', { timeout: 30000 }, async () => {
	let nodePath = '/local/test-node-semaphore-methods'
	await createCoordinationNode(nodePath)

	await using session = await client.session(nodePath)

	await session.create('test-sem', {
		limit: 1,
		data: new Uint8Array([1, 2, 3]),
	})

	await using semaphore = await session.acquire('test-sem', { count: 1 })

	expect(semaphore.name).toBe('test-sem')

	let desc = await semaphore.describe({ includeOwners: true })
	expect(desc.description).toBeDefined()
	expect(desc.description!.count).toBe(1n)
	expect(Array.from(desc.description!.data)).toEqual([1, 2, 3])
	expect(desc.description!.owners).toBeDefined()
	expect(desc.description!.owners.length).toBe(1)

	await semaphore.update(new Uint8Array([4, 5, 6]))

	let updatedDesc = await semaphore.describe()
	expect(Array.from(updatedDesc.description!.data)).toEqual([4, 5, 6])

	await semaphore.release()

	await semaphore.delete()

	await dropCoordinationNode(nodePath)
})

test(
	'aborts session creation with AbortSignal timeout',
	{ timeout: 30000 },
	async () => {
		let nodePath = '/local/test-node-signal-timeout'
		await createCoordinationNode(nodePath)

		try {
			await expect(
				client.session(nodePath, undefined, AbortSignal.timeout(0))
			).rejects.toThrow('AbortError')
		} finally {
			await dropCoordinationNode(nodePath)
		}
	}
)

test('watch stops on abort signal', { timeout: 30000 }, async () => {
	let nodePath = '/local/test-node-watch-3'
	await createCoordinationNode(nodePath)

	await using session = await client.session(nodePath)

	await session.create('test-sem', {
		limit: 1,
		data: new Uint8Array([1]),
	})

	let controller = new AbortController()
	let updateCount = 0

	let watchPromise = (async () => {
		for await (let _ of session.watch(
			'test-sem',
			{ data: true },
			controller.signal
		)) {
			updateCount++
		}
	})()

	await sleep(100)

	// Abort after initial value
	controller.abort()

	await sleep(100)

	await session.update('test-sem', new TextEncoder().encode('data'))

	await watchPromise

	// Should only get initial value
	expect(updateCount).toBe(1)

	await session.delete('test-sem')
	await dropCoordinationNode(nodePath)
})

test(
	'watch requires at least one watch option',
	{ timeout: 30000 },
	async () => {
		let nodePath = '/local/test-node-watch-4'
		await createCoordinationNode(nodePath)

		await using session = await client.session(nodePath)

		await session.create('test-sem', { limit: 1 })

		await expect(async () => {
			for await (let _ of session.watch('test-sem', {})) {
			}
		}).rejects.toThrow(
			'At least one of options.data or options.owners must be true'
		)

		await session.delete('test-sem')
		await dropCoordinationNode(nodePath)
	}
)

test('watch with both data and owners', { timeout: 30000 }, async () => {
	let nodePath = '/local/test-node-watch-5'
	await createCoordinationNode(nodePath)

	let session1 = await client.session(nodePath)
	let session2 = await client.session(nodePath)

	try {
		await session1.create('multi-sem', {
			limit: 1,
			data: new TextEncoder().encode('initial'),
		})

		let controller = new AbortController()
		let updates: Array<{ data: string; owners: number }> = []

		let watchPromise = (async () => {
			for await (let desc of session1.watch(
				'multi-sem',
				{ data: true, owners: true },
				controller.signal
			)) {
				updates.push({
					data: new TextDecoder().decode(desc.data),
					owners: desc.owners?.length ?? 0,
				})

				if (updates.length >= 3) {
					break
				}
			}
		})()

		await sleep(100)

		// Trigger owner change
		await session2.acquire('multi-sem', { count: 1 })
		await sleep(100)

		// Trigger data change
		await session1.update('multi-sem', new TextEncoder().encode('updated'))
		await sleep(100)

		await watchPromise

		expect(updates.length).toBe(3)
		expect(updates[0]).toEqual({ data: 'initial', owners: 0 })
		expect(updates[1]).toEqual({ data: 'initial', owners: 1 })
		expect(updates[2]).toEqual({ data: 'updated', owners: 1 })

		await session2.release('multi-sem')
		await session1.delete('multi-sem')
	} finally {
		await session1.close()
		await session2.close()
		await dropCoordinationNode(nodePath)
	}
})
