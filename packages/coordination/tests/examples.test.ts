import { expect, inject, test } from 'vitest'

import { Driver } from '@ydbjs/core'

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

/**
 * Example 1: Leader Election
 * https://ydb.tech/docs/ru/recipes/ydb-sdk/leader-election?version=v25.2
 *
 * Multiple application instances want to elect a leader and always know who it is.
 *
 * Algorithm:
 * 1. Create a semaphore (e.g., my-service-leader) with Limit=1
 * 2. All instances call AcquireSemaphore with Count=1, specifying their endpoint in Data
 * 3. Only one instance completes quickly and becomes the leader, others queue up
 * 4. All instances call DescribeSemaphore with WatchOwners=true and IncludeOwners=true
 *    to get the current leader's endpoint from Owners[0].Data
 * 5. When leader changes, OnChanged is called, and instances call DescribeSemaphore again
 */
test('leader election example', { timeout: 30000 }, async () => {
	let nodePath = '/local/leader-election-node'
	await createCoordinationNode(nodePath)

	// Shared state to track leader changes
	let instance1Leaders: string[] = []
	let instance2Leaders: string[] = []
	let instance3Leaders: string[] = []

	// Function that each application instance runs
	async function runInstance(
		instanceId: string,
		endpoint: string,
		leaderLog: string[]
	): Promise<void> {
		let session = await client.session(nodePath, {
			description: instanceId,
		})

		try {
			session.on(
				CoordinationSessionEvents.SEMAPHORE_CHANGED,
				async (event: SemaphoreChangedEvent) => {
					if (
						event.name === 'my-service-leader' &&
						event.ownersChanged
					) {
						try {
							let { description } = await session.describe(
								'my-service-leader',
								{ includeOwners: true, watchOwners: true }
							)

							if (
								description &&
								description.owners &&
								description.owners.length > 0
							) {
								let leaderEndpoint = new TextDecoder().decode(
									description.owners[0]!.data
								)
								leaderLog.push(leaderEndpoint)
							}
						} catch {
							// Semaphore might be deleted
						}
					}
				}
			)

			//  Set watcher and get initial state
			let { description, watchAdded } = await session.describe(
				'my-service-leader',
				{ includeOwners: true, watchOwners: true }
			)
			expect(watchAdded).toBe(true)

			// Record initial leader if exists
			if (
				description &&
				description.owners &&
				description.owners.length > 0
			) {
				let leaderEndpoint = new TextDecoder().decode(
					description.owners[0]!.data
				)
				leaderLog.push(leaderEndpoint)
			}

			// Try to acquire leadership (will wait indefinitely in queue)
			let semaphore = await session.acquire('my-service-leader', {
				count: 1,
				timeoutMillis: Infinity,
				data: new TextEncoder().encode(endpoint),
			})
			let isLeader = semaphore.acquired

			if (isLeader) {
				// This instance is now the leader
				// Do some work as leader
				await sleep(100)

				// Release leadership
				await session.release('my-service-leader')
			}

			// Wait a bit to observe leader changes
			await sleep(1500)
		} finally {
			await session.close()
		}
	}

	try {
		// Create leader semaphore with Limit=1
		let setupSession = await client.session(nodePath)
		await setupSession.create('my-service-leader', { limit: 1 })
		await setupSession.close()

		// Run 3 instances competing for leadership
		await Promise.all([
			runInstance('instance-1', 'host1:8080', instance1Leaders),
			runInstance('instance-2', 'host2:8080', instance2Leaders),
			runInstance('instance-3', 'host3:8080', instance3Leaders),
		])

		// Verify: all instances observed at least some leaders
		expect(instance1Leaders.length).toBeGreaterThanOrEqual(1)
		expect(instance2Leaders.length).toBeGreaterThanOrEqual(1)
		expect(instance3Leaders.length).toBeGreaterThanOrEqual(1)

		// Verify: all 3 endpoints became leaders at some point
		let allLeaders = new Set([
			...instance1Leaders,
			...instance2Leaders,
			...instance3Leaders,
		])
		expect(allLeaders.size).toBe(3)
		expect(allLeaders.has('host1:8080')).toBe(true)
		expect(allLeaders.has('host2:8080')).toBe(true)
		expect(allLeaders.has('host3:8080')).toBe(true)
	} finally {
		await dropCoordinationNode(nodePath)
	}
})

/**
 * Example 2: Service Discovery
 * https://ydb.tech/docs/ru/recipes/ydb-sdk/service-discovery?version=v25.2
 *
 * Application instances dynamically start up and publish their endpoints,
 * while also discovering other instances.
 *
 * Algorithm:
 * 1. Create a semaphore (e.g., my-service-endpoints) with Limit=Max<ui64>()
 * 2. All instances call AcquireSemaphore with Count=1, specifying their endpoint in Data
 * 3. Since the limit is very large, all AcquireSemaphore calls complete quickly
 * 4. All instances call DescribeSemaphore with IncludeOwners=true and WatchOwners=true
 *    to get the list of registered endpoints from Owners[].Data
 * 5. When the endpoint list changes, OnChanged is called, and instances call DescribeSemaphore again
 * 6. When session terminates, endpoint is automatically removed
 */
test('service discovery example', { timeout: 30000 }, async () => {
	let nodePath = '/local/service-discovery-node'
	await createCoordinationNode(nodePath)

	// Track endpoint lists observed by each instance
	let instance1Endpoints: string[][] = []
	let instance2Endpoints: string[][] = []
	let instance3Endpoints: string[][] = []

	// Function that each service instance runs
	async function runInstance(
		instanceId: string,
		endpoint: string,
		endpointLog: string[][]
	): Promise<void> {
		let session = await client.session(nodePath, {
			description: instanceId,
		})

		try {
			session.on(
				CoordinationSessionEvents.SEMAPHORE_CHANGED,
				async (event) => {
					if (
						event.name === 'my-service-endpoints' &&
						event.ownersChanged
					) {
						try {
							let { description } = await session.describe(
								'my-service-endpoints',
								{ includeOwners: true, watchOwners: true }
							)

							if (description && description.owners) {
								let endpoints = description.owners.map(
									(owner) =>
										new TextDecoder().decode(owner.data)
								)
								endpointLog.push(endpoints)
							}
						} catch {
							// Semaphore might be deleted
						}
					}
				}
			)

			// Set watcher
			let { watchAdded } = await session.describe(
				'my-service-endpoints',
				{ includeOwners: true, watchOwners: true }
			)
			expect(watchAdded).toBe(true)

			// Register this instance by acquiring semaphore with endpoint in Data
			let semaphore = await session.acquire('my-service-endpoints', {
				count: 1,
				data: new TextEncoder().encode(endpoint),
			})
			expect(semaphore.acquired).toBe(true)

			// Keep session alive (simulating running service)
			await sleep(500)
		} finally {
			// When session closes, endpoint is automatically removed
			await session.close()
		}
	}

	try {
		// Create service discovery semaphore with very large limit
		let setupSession = await client.session(nodePath)
		await setupSession.create('my-service-endpoints', { limit: Infinity })
		await setupSession.close()

		// Start all instances - they register and discover each other
		await Promise.all([
			runInstance('instance-1', 'host1:8080', instance1Endpoints),
			runInstance('instance-2', 'host2:8080', instance2Endpoints),
			runInstance('instance-3', 'host3:8080', instance3Endpoints),
		])

		// Verify: all instances saw all 3 endpoints at some point
		for (let instanceEndpoints of [
			instance1Endpoints,
			instance2Endpoints,
			instance3Endpoints,
		]) {
			let allEndpoints = new Set(instanceEndpoints.flat())
			expect(allEndpoints.has('host1:8080')).toBe(true)
			expect(allEndpoints.has('host2:8080')).toBe(true)
			expect(allEndpoints.has('host3:8080')).toBe(true)
		}
	} finally {
		await dropCoordinationNode(nodePath)
	}
})

/**
 * Example 3: Configuration Publication
 * https://ydb.tech/docs/ru/recipes/ydb-sdk/config-publication?version=v25.2
 *
 * A scenario where a small configuration needs to be published for application instances
 * that must react quickly to changes.
 *
 * Algorithm:
 * 1. Create a semaphore (e.g., my-service-config)
 * 2. Publish updated configuration via UpdateSemaphore
 * 3. Application instances call DescribeSemaphore with WatchData=true,
 *    and receive the current configuration version in Data
 * 4. When configuration changes, OnChanged is called, and instances
 *    call DescribeSemaphore again to get the updated configuration
 */
test('configuration publication example', { timeout: 30000 }, async () => {
	let nodePath = '/local/config-publication-node'
	await createCoordinationNode(nodePath)

	// Track configuration versions observed by each instance
	let instance1Configs: string[] = []
	let instance2Configs: string[] = []
	let instance3Configs: string[] = []

	// Function that each application instance runs
	async function runInstance(
		instanceId: string,
		configLog: string[]
	): Promise<void> {
		let session = await client.session(nodePath, {
			description: instanceId,
		})

		try {
			session.on(
				CoordinationSessionEvents.SEMAPHORE_CHANGED,
				async (event: SemaphoreChangedEvent) => {
					if (
						event.name === 'my-service-config' &&
						event.dataChanged
					) {
						try {
							let { description } = await session.describe(
								'my-service-config',
								{ watchData: true }
							)

							if (description && description.data) {
								let config = new TextDecoder().decode(
									description.data
								)
								configLog.push(config)
							}
						} catch {
							// Semaphore might be deleted
						}
					}
				}
			)

			// Set watcher and get initial configuration
			let { description, watchAdded } = await session.describe(
				'my-service-config',
				{ watchData: true }
			)
			expect(watchAdded).toBe(true)

			// Store initial configuration
			if (description && description.data) {
				let config = new TextDecoder().decode(description.data)
				configLog.push(config)
			}

			// Keep session alive (simulating running service)
			await sleep(1000)
		} finally {
			await session.close()
		}
	}

	try {
		let publisherSession = await client.session(nodePath)
		await publisherSession.create('my-service-config', {
			limit: 1,
			data: new TextEncoder().encode('config-v1'),
		})

		// Start all instances - they will watch for config changes
		let instancesPromise = Promise.all([
			runInstance('instance-1', instance1Configs),
			runInstance('instance-2', instance2Configs),
			runInstance('instance-3', instance3Configs),
		])

		await sleep(200)

		await publisherSession.update(
			'my-service-config',
			new TextEncoder().encode('config-v2')
		)

		await sleep(200)

		await publisherSession.update(
			'my-service-config',
			new TextEncoder().encode('config-v3')
		)

		await sleep(200)

		await publisherSession.close()

		await instancesPromise

		// Verify: all instances saw the same configs in the same order
		for (let instanceConfigs of [
			instance1Configs,
			instance2Configs,
			instance3Configs,
		]) {
			expect(instanceConfigs.length).toBe(3)
			expect(instanceConfigs).toEqual([
				'config-v1',
				'config-v2',
				'config-v3',
			])
		}
	} finally {
		await dropCoordinationNode(nodePath)
	}
})
