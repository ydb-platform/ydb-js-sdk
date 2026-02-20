import { expect, inject, test } from 'vitest'
import { setTimeout as sleep } from 'node:timers/promises'

import { Driver } from '@ydbjs/core'

import { coordination } from '../src/index.js'

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
 * Example 1: Service Discovery
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

		let abortController = new AbortController()

		try {
			// Watch for endpoint changes in background
			;(async () => {
				try {
					for await (let description of session.watch(
						'my-service-endpoints',
						{ owners: true },
						abortController.signal
					)) {
						if (description.owners) {
							let endpoints = description.owners.map((owner) =>
								new TextDecoder().decode(owner.data)
							)
							endpointLog.push(endpoints)
						}
					}
				} catch {
					// Watch stopped or semaphore deleted
				}
			})()

			// Register this instance by acquiring semaphore with endpoint in Data
			// Using acquire() guarantees we got the lock when it returns
			await session.acquire('my-service-endpoints', {
				count: 1,
				data: new TextEncoder().encode(endpoint),
			})

			// Keep session alive (simulating running service)
			await sleep(500)
		} finally {
			abortController.abort()
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
 * Example 2: Configuration Publication
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

		let abortController = new AbortController()

		try {
			// Watch for config changes in background
			;(async () => {
				try {
					for await (let description of session.watch(
						'my-service-config',
						{ data: true },
						abortController.signal
					)) {
						if (description.data) {
							let config = new TextDecoder().decode(
								description.data
							)
							configLog.push(config)
						}
					}
				} catch {
					// Watch stopped or semaphore deleted
				}
			})()

			// Keep session alive (simulating running service)
			await sleep(1000)
		} finally {
			abortController.abort()
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
