import { expect, inject, test } from 'vitest'
import { setTimeout as sleep } from 'node:timers/promises'

import { Driver } from '@ydbjs/core'

import { coordination } from '../src/index.js'

let driver = new Driver(inject('connectionString'), {
	'ydb.sdk.enable_discovery': false,
})

let client = coordination(driver)

test('leader election example', { timeout: 30000 }, async () => {
	let nodePath = '/local/leader-election-node'
	await client.createNode(nodePath)

	try {
		// Shared state to track leader changes
		let instance1Leaders: string[] = []
		let instance2Leaders: string[] = []
		let instance3Leaders: string[] = []

		// Function that each application instance runs
		async function runInstance(
			endpoint: string,
			leaderLog: string[]
		): Promise<void> {
			let abortController = new AbortController()

			for await (let leader of client.election(
				nodePath,
				'my-service-leader',
				{
					data: new TextEncoder().encode(endpoint),
					signal: abortController.signal,
				}
			)) {
				// Log current leader
				let leaderEndpoint = new TextDecoder().decode(leader.data)
				leaderLog.push(leaderEndpoint)

				if (leader.isMe) {
					// This instance is now the leader - do some work
					await sleep(100)

					abortController.abort()
					break
				}

				await new Promise<void>((resolve) => {
					leader.signal.addEventListener('abort', () => resolve())
				})
			}
		}

		// Run 3 instances competing for leadership
		await Promise.all([
			runInstance('host1:8080', instance1Leaders),
			runInstance('host2:8080', instance2Leaders),
			runInstance('host3:8080', instance3Leaders),
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
		await client.dropNode(nodePath)
	}
})
