import { expect, inject, test } from 'vitest'

import { Driver } from '@ydbjs/core'
import { YDBError } from '@ydbjs/error'

import {
	CoordinationSessionEvents,
	type SemaphoreChangedEvent,
	coordination,
} from '../src/index.js'
import { sleep } from './helpers.js'

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
			let acquired = await session.acquireSemaphore({
				name: 'test-lock',
				count: 1,
				ephemeral: true,
			})
			expect(acquired).toBe(true)

			// Release semaphore (deleted automatically)
			let released = await session.releaseSemaphore({
				name: 'test-lock',
			})
			expect(released).toBe(true)
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
			await session.createSemaphore({
				name: 'test-lock',
				limit: 1,
			})

			let acquired = await session.acquireSemaphore({
				name: 'test-lock',
				count: 1,
			})
			expect(acquired).toBe(true)

			let released = await session.releaseSemaphore({
				name: 'test-lock',
			})
			expect(released).toBe(true)

			await session.deleteSemaphore({
				name: 'test-lock',
			})
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
		await session.createSemaphore({
			name: 'test-semaphore',
			limit: 5,
		})

		let { description } = await session.describeSemaphore({
			name: 'test-semaphore',
		})
		expect(description!.count).toBe(0n) // 0 tokens acquired
		expect(description!.limit).toBe(5n) // limit is 5

		await session.deleteSemaphore({
			name: 'test-semaphore',
		})
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
		await session.createSemaphore({
			name: 'test-semaphore',
			limit: 3,
			data: new Uint8Array([1, 2, 3]),
		})

		await session.updateSemaphore({
			name: 'test-semaphore',
			data: new Uint8Array([4, 5, 6]),
		})

		let { description } = await session.describeSemaphore({
			name: 'test-semaphore',
		})
		expect(Array.from(description!.data)).toEqual([4, 5, 6])

		await session.deleteSemaphore({
			name: 'test-semaphore',
		})
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
		await session1.createSemaphore({
			name: 'exclusive-lock',
			limit: 1,
		})

		// Session 1 acquires
		let acquired1 = await session1.acquireSemaphore({
			name: 'exclusive-lock',
			count: 1,
		})
		expect(acquired1).toBe(true)

		// Session 2 tries to acquire with timeout (should fail)
		let acquired2 = await session2.acquireSemaphore({
			name: 'exclusive-lock',
			count: 1,
			timeoutMillis: 100,
		})
		expect(acquired2).toBe(false)

		// Session 1 releases
		await session1.releaseSemaphore({
			name: 'exclusive-lock',
		})

		// Session 2 can now acquire
		let acquired3 = await session2.acquireSemaphore({
			name: 'exclusive-lock',
			count: 1,
		})
		expect(acquired3).toBe(true)

		await session2.releaseSemaphore({
			name: 'exclusive-lock',
		})
		await session1.deleteSemaphore({
			name: 'exclusive-lock',
		})
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
		await session1.createSemaphore({
			name: 'test-lock',
			limit: 1,
		})

		await session1.acquireSemaphore({
			name: 'test-lock',
			count: 1,
		})

		// Session 2 tries to acquire (will wait indefinitely)
		let acquirePromise = session2.acquireSemaphore({
			name: 'test-lock',
			count: 1,
		})

		// Wait a bit to ensure request is sent and pending
		await sleep(100)

		// Close session 2 - should reject pending request
		await session2.close()

		await expect(acquirePromise).rejects.toThrow('Stream closed')

		await session1.releaseSemaphore({ name: 'test-lock' })
		await session1.deleteSemaphore({ name: 'test-lock' })
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
		await session.createSemaphore({
			name: 'sem1',
			limit: 2,
		})
		await session.createSemaphore({
			name: 'sem2',
			limit: 3,
		})

		let acquired1 = await session.acquireSemaphore({
			name: 'sem1',
			count: 1,
		})
		let acquired2 = await session.acquireSemaphore({
			name: 'sem2',
			count: 2,
		})
		expect(acquired1).toBe(true)
		expect(acquired2).toBe(true)

		let { description: desc1 } = await session.describeSemaphore({
			name: 'sem1',
		})
		let { description: desc2 } = await session.describeSemaphore({
			name: 'sem2',
		})

		expect(desc1!.count).toBe(1n)
		expect(desc2!.count).toBe(2n)

		await session.releaseSemaphore({ name: 'sem1' })
		await session.releaseSemaphore({ name: 'sem2' })

		await session.deleteSemaphore({ name: 'sem1' })
		await session.deleteSemaphore({ name: 'sem2' })
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

			await session1.createSemaphore({
				name: 'exclusive-lock',
				limit: 1,
			})

			await session1.acquireSemaphore({
				name: 'exclusive-lock',
				count: 1,
			})

			// Session 2 tries to acquire (will be pending because session1 holds it)
			let pendingAcquire = session2.acquireSemaphore({
				name: 'exclusive-lock',
				count: 1,
			})

			// Wait to ensure request is sent and becomes pending on server
			await sleep(100)

			// Describe with owners and waiters
			let { description } = await session1.describeSemaphore({
				name: 'exclusive-lock',
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

			// Force reconnection via forceReconnect()
			session2.forceReconnect()

			// Session 1 sends request to release the lock
			session1.releaseSemaphore({ name: 'exclusive-lock' })

			// Wait to ensure request is sent and becomes pending on client
			await sleep(100)

			// Session 2's pending request should be retried after reconnect
			// and should succeed now that session 1 released the lock
			let acquired = await pendingAcquire
			expect(acquired).toBe(true)

			// Describe with owners and waiters
			let { description: newDescription } =
				await session2.describeSemaphore({
					name: 'exclusive-lock',
					includeOwners: true,
					includeWaiters: true,
				})

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

			await session2.releaseSemaphore({ name: 'exclusive-lock' })
			await session1.deleteSemaphore({ name: 'exclusive-lock' })
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
			await sessions[0].createSemaphore({
				name: 'limited-resource',
				limit: 2,
			})

			let acquirePromises = sessions.map((session) =>
				session.acquireSemaphore({
					name: 'limited-resource',
					count: 1,
					timeoutMillis: 500,
				})
			)

			let results = await Promise.all(acquirePromises)
			let acquiredCount = results.filter((r) => r === true).length
			// Only 2 should have acquired (others timed out)
			expect(acquiredCount).toBe(2)

			for (let i = 0; i < sessions.length; i++) {
				if (results[i] && sessions[i]) {
					// eslint-disable-next-line no-await-in-loop
					await sessions[i]!.releaseSemaphore({
						name: 'limited-resource',
					})
				}
			}

			await sessions[0].deleteSemaphore({ name: 'limited-resource' })
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
		await session.createSemaphore({
			name: 'watched-sem',
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
		let desc = await session.describeSemaphore({
			name: 'watched-sem',
			watchData: true,
			watchOwners: true,
		})
		expect(desc).toBeDefined()

		// Update semaphore data - should trigger change event
		await session.updateSemaphore({
			name: 'watched-sem',
			data: new Uint8Array([4, 5, 6]),
		})

		await sleep(100)

		// Verify event was emitted
		expect(changedEvents.length).toBeGreaterThan(0)
		expect(changedEvents[0]?.name).toBe('watched-sem')
		expect(changedEvents[0]?.dataChanged).toBe(true)

		await session.deleteSemaphore({ name: 'watched-sem' })
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
			session.acquireSemaphore({
				name: 'non-existent-sem',
				count: 1,
				ephemeral: false,
			})
		).rejects.toThrow(YDBError)

		// Try to delete non-existent semaphore
		await expect(
			session.deleteSemaphore({
				name: 'non-existent-sem',
			})
		).rejects.toThrow(YDBError)

		// Try to update non-existent semaphore
		await expect(
			session.updateSemaphore({
				name: 'non-existent-sem',
				data: new Uint8Array([1, 2, 3]),
			})
		).rejects.toThrow(YDBError)

		// Try to describe non-existent semaphore
		await expect(
			session.describeSemaphore({
				name: 'non-existent-sem',
			})
		).rejects.toThrow(YDBError)
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
		let session = await client.session(nodePath, {
			timeoutMillis: 1,
		})

		try {
			let initialSessionId = session.sessionId
			expect(initialSessionId).toBeGreaterThan(0n)

			let acquired = await session.acquireSemaphore({
				name: 'test-sem',
				ephemeral: true,
			})
			expect(acquired).toBe(true)

			// Force disconnect to simulate network issue
			session.forceReconnect()

			await sleep(100)

			// Session expired, so semaphore from old session won't exist
			await expect(
				session.describeSemaphore({
					name: 'test-sem',
				})
			).rejects.toThrow(YDBError)

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
			await session1.createSemaphore({
				name: 'exclusive-lock',
				limit: 1,
			})
			await session1.acquireSemaphore({
				name: 'exclusive-lock',
				count: 1,
			})

			// Session2 tries to acquire with short timeout - will be pending and then abort
			await expect(
				session2.acquireSemaphore(
					{
						name: 'exclusive-lock',
						count: 1,
					},
					AbortSignal.timeout(1)
				)
			).rejects.toThrow('AbortError')

			await session1.releaseSemaphore({ name: 'exclusive-lock' })
		} finally {
			await session1.close()
			await session2.close()
			await dropCoordinationNode(nodePath)
		}
	}
)
