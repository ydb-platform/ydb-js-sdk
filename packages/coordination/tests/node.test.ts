import { beforeEach, expect, inject, onTestFinished, test } from 'vitest'

import { Driver } from '@ydbjs/core'
import { CoordinationClient } from '@ydbjs/coordination'
import { YDBError } from '@ydbjs/error'

declare module 'vitest' {
	export interface ProvidedContext {
		connectionString: string
	}
}

let driver = new Driver(inject('connectionString'), {
	'ydb.sdk.enable_discovery': false,
})

await driver.ready()

let client = new CoordinationClient(driver)

let testNodePath: string

beforeEach(() => {
	let suffix = `${Date.now()}-${Math.floor(Math.random() * 0xffff).toString(16)}`
	testNodePath = `/local/test-coord-node-${suffix}`
})

test('round-trips config through create and describe', async (tc) => {
	await client.createNode(
		testNodePath,
		{ selfCheckPeriod: 1000, sessionGracePeriod: 5000 },
		tc.signal
	)
	onTestFinished(async () => {
		await client.dropNode(testNodePath, AbortSignal.timeout(5000)).catch(() => {})
	})

	let description = await client.describeNode(testNodePath, tc.signal)

	expect(description.config.selfCheckPeriod).toBe(1000)
	expect(description.config.sessionGracePeriod).toBe(5000)
	expect(description.self).toBeDefined()
})

test('alters an existing node config', async (tc) => {
	await client.createNode(testNodePath, { selfCheckPeriod: 1000 }, tc.signal)
	onTestFinished(async () => {
		await client.dropNode(testNodePath, AbortSignal.timeout(5000)).catch(() => {})
	})

	await client.alterNode(testNodePath, { selfCheckPeriod: 2000 }, tc.signal)

	let description = await client.describeNode(testNodePath, tc.signal)
	expect(description.config.selfCheckPeriod).toBe(2000)
})

test('removing the node causes describe to fail', async (tc) => {
	await client.createNode(testNodePath, {}, tc.signal)

	await client.dropNode(testNodePath, tc.signal)

	await expect(client.describeNode(testNodePath, tc.signal)).rejects.toBeInstanceOf(YDBError)
})

test('allows recreating a node at the same path', async (tc) => {
	await client.createNode(testNodePath, {}, tc.signal)
	onTestFinished(async () => {
		await client.dropNode(testNodePath, AbortSignal.timeout(5000)).catch(() => {})
	})

	// Real YDB accepts a repeat CreateNode for the same path without error —
	// worth knowing since it means create() cannot be used to detect "already
	// exists" the way one might expect from, say, a filesystem mkdir.
	await expect(client.createNode(testNodePath, {}, tc.signal)).resolves.toBeUndefined()
})

test('rejects when describing a missing node', async (tc) => {
	await expect(client.describeNode(`${testNodePath}-missing`, tc.signal)).rejects.toBeInstanceOf(
		YDBError
	)
})
