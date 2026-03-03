import { expect, inject, test } from 'vitest'
import { Driver } from '@ydbjs/core'
import { ConsistencyMode, coordination } from '../src/index.js'
import { YDBError } from '@ydbjs/error'

let driver = new Driver(inject('connectionString'), {
	'ydb.sdk.enable_discovery': false,
})
let client = coordination(driver)

test('creates and drops coordination node', async () => {
	let nodePath = '/local/test-node-create-drop'

	await client.createNode(nodePath)

	let session = await client.session(nodePath)
	expect(session.sessionId).toBeGreaterThan(0)
	await session.close()

	await client.dropNode(nodePath)

	await expect(client.describeNode(nodePath)).rejects.throws(YDBError)
})

test('creates coordination node with config', async () => {
	let nodePath = '/local/test-node-with-config'

	await client.createNode(nodePath, {
		selfCheckPeriodMillis: 2000,
		sessionGracePeriodMillis: 15000,
		readConsistencyMode: ConsistencyMode.STRICT,
		attachConsistencyMode: ConsistencyMode.RELAXED,
	})

	let description = await client.describeNode(nodePath)
	expect(description).toBeDefined()
	expect(description.config).toBeDefined()
	expect(description.config?.selfCheckPeriodMillis).toBe(2000)
	expect(description.config?.sessionGracePeriodMillis).toBe(15000)
	expect(description.config?.readConsistencyMode).toBe(ConsistencyMode.STRICT)
	expect(description.config?.attachConsistencyMode).toBe(
		ConsistencyMode.RELAXED
	)

	await client.alterNode(nodePath, {
		selfCheckPeriodMillis: 3000,
		sessionGracePeriodMillis: 20000,
	})

	description = await client.describeNode(nodePath)
	expect(description).toBeDefined()
	expect(description.config).toBeDefined()
	expect(description.config?.selfCheckPeriodMillis).toBe(3000)
	expect(description.config?.sessionGracePeriodMillis).toBe(20000)

	await client.dropNode(nodePath)
})

test('throws error on operations for non-existent node', async () => {
	let nodePath = '/local/test-node-non-existent'

	await expect(client.dropNode(nodePath)).rejects.throws(YDBError)
	await expect(client.describeNode(nodePath)).rejects.throws(YDBError)
	await expect(
		client.alterNode(nodePath, {
			selfCheckPeriodMillis: 2000,
		})
	).rejects.throws(YDBError)
})
