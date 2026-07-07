import { beforeEach, expect, inject, onTestFinished, test } from 'vitest'

import { Driver } from '@ydbjs/core'
import { CoordinationClient, SessionClosedError } from '@ydbjs/coordination'
import { YDBError } from '@ydbjs/error'

// #region setup
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
	testNodePath = `/local/test-coord-node-${Date.now()}-${Math.floor(Math.random() * 0xffff).toString(16)}`

	// Some tests drop the node themselves — swallow the error if it is already gone
	onTestFinished(() => client.dropNode(testNodePath, AbortSignal.timeout(5000)).catch(() => {}))
})
// #endregion

test('creates and describes a coordination node', async (tc) => {
	await client.createNode(
		testNodePath,
		{ selfCheckPeriod: 1000, sessionGracePeriod: 5000 },
		tc.signal
	)

	let description = await client.describeNode(testNodePath, tc.signal)

	expect(description.config.selfCheckPeriod).toBe(1000)
	expect(description.config.sessionGracePeriod).toBe(5000)
})

test('alters node configuration', async (tc) => {
	await client.createNode(
		testNodePath,
		{ selfCheckPeriod: 1000, sessionGracePeriod: 5000 },
		tc.signal
	)

	await client.alterNode(
		testNodePath,
		{ selfCheckPeriod: 2000, sessionGracePeriod: 10000 },
		tc.signal
	)

	let description = await client.describeNode(testNodePath, tc.signal)

	expect(description.config.selfCheckPeriod).toBe(2000)
	expect(description.config.sessionGracePeriod).toBe(10000)
})

test('drops a coordination node', async (tc) => {
	await client.createNode(testNodePath, {}, tc.signal)

	await client.dropNode(testNodePath, tc.signal)

	// Node is gone — describe must reject
	await expect(client.describeNode(testNodePath, tc.signal)).rejects.toBeInstanceOf(YDBError)
})

test('describes a non-existent node throws an error', async (tc) => {
	await expect(client.describeNode(testNodePath, tc.signal)).rejects.toBeInstanceOf(YDBError)
})

test('creates a session on an existing node', async (tc) => {
	await client.createNode(testNodePath, {}, tc.signal)

	let session = await client.createSession(testNodePath, {}, tc.signal)

	try {
		expect(session.sessionId).not.toBeNull()
	} finally {
		await session.close(tc.signal)
	}
})

test('closes a session gracefully via async dispose', async (tc) => {
	await client.createNode(testNodePath, {}, tc.signal)

	// Session signal must be alive inside the block and the dispose must not throw
	await using session = await client.createSession(testNodePath, {}, tc.signal)

	expect(session.sessionId).not.toBeNull()
	expect(session.signal.aborted).toBe(false)
})

test('withSession runs callback and returns result', async (tc) => {
	await client.createNode(testNodePath, {}, tc.signal)

	let result = await client.withSession(
		testNodePath,
		async (session) => {
			expect(session.sessionId).not.toBeNull()
			return 'ok'
		},
		{},
		tc.signal
	)

	expect(result).toBe('ok')
})

test('createSession rejects when signal is already aborted', async (tc) => {
	await client.createNode(testNodePath, {}, tc.signal)

	let aborted = AbortSignal.abort(new Error('pre-aborted'))

	await expect(client.createSession(testNodePath, {}, aborted)).rejects.toThrow('pre-aborted')
})

test('session.signal.reason is SessionClosedError after close', async (tc) => {
	await client.createNode(testNodePath, {}, tc.signal)

	let session = await client.createSession(testNodePath, {}, tc.signal)
	await session.close(tc.signal)

	expect(session.signal.aborted).toBe(true)
	expect(session.signal.reason).toBeInstanceOf(SessionClosedError)
})

test('session.signal carries custom reason after destroy', async (tc) => {
	await client.createNode(testNodePath, {}, tc.signal)

	let session = await client.createSession(testNodePath, {}, tc.signal)
	let reason = new Error('custom destroy reason')
	session.destroy(reason)

	await new Promise((r) => setTimeout(r, 100))

	expect(session.signal.aborted).toBe(true)
	expect(session.signal.reason).toBe(reason)
})
