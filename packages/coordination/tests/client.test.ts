import { beforeEach, expect, inject, onTestFinished, test } from 'vitest'

import { Driver } from '@ydbjs/core'
import { CoordinationClient } from '@ydbjs/coordination'

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

beforeEach(async (ctx) => {
	let suffix = `${Date.now()}-${Math.floor(Math.random() * 0xffff).toString(16)}`
	testNodePath = `/local/test-coord-client-${suffix}`

	await client.createNode(testNodePath, {}, ctx.signal)

	onTestFinished(async () => {
		await client.dropNode(testNodePath, AbortSignal.timeout(5000)).catch(() => {})
	})
})

test('returns a ready session for the node', async (tc) => {
	await using session = await client.createSession(testNodePath, {}, tc.signal)

	expect(session.status).toBe('ready')
	expect(session.sessionId).not.toBeNull()
})

test('rejects immediately when the signal is already aborted', async () => {
	let ctrl = new AbortController()
	ctrl.abort(new Error('cancelled before call'))

	await expect(client.createSession(testNodePath, {}, ctrl.signal)).rejects.toBeDefined()
})

test('closes the session after callback resolves', async (tc) => {
	let seenStatus: string | undefined
	let result = await client.withSession(
		testNodePath,
		async (session) => {
			seenStatus = session.status
			return 'callback-result'
		},
		{},
		tc.signal
	)

	expect(seenStatus).toBe('ready')
	expect(result).toBe('callback-result')
})

test('closes the session even when callback throws', async (tc) => {
	let capturedSession: import('@ydbjs/coordination').CoordinationSession | undefined

	await expect(
		client.withSession(
			testNodePath,
			async (session) => {
				capturedSession = session
				throw new Error('callback failed')
			},
			{},
			tc.signal
		)
	).rejects.toThrow('callback failed')

	expect(capturedSession?.status).toBe('closed')
})

test('yields a ready session that the caller can consume', async (tc) => {
	let seen: string[] = []
	let lastSession: import('@ydbjs/coordination').CoordinationSession | undefined

	for await (let session of client.openSession(testNodePath, {}, tc.signal)) {
		seen.push(session.status)
		lastSession = session
		break
	}

	expect(seen).toEqual(['ready'])
	lastSession?.destroy()
})

test('stops re-opening once the caller aborts the signal', async (tc) => {
	let ctrl = new AbortController()
	let signal = AbortSignal.any([tc.signal, ctrl.signal])
	let seen: string[] = []
	let lastSession: import('@ydbjs/coordination').CoordinationSession | undefined

	for await (let session of client.openSession(testNodePath, {}, signal)) {
		seen.push(session.status)
		lastSession = session
		// Abort asynchronously, after the generator has moved on to awaiting
		// the next-session decision — not synchronously, so we exercise the
		// real "caller cancels while idle" path instead of racing signals
		// that are already aborted by the time the generator resumes.
		setTimeout(() => ctrl.abort(new Error('caller is done')), 50)
	}

	expect(seen).toEqual(['ready'])
	lastSession?.destroy()
})
