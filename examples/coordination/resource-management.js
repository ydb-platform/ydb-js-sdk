/**
 * Resource Management with `await using`
 *
 * JavaScript's Explicit Resource Management proposal (TC39 stage 4, Node >= 18)
 * gives us `using` and `await using` — a language-level guarantee that a
 * resource is disposed when the enclosing scope exits, no matter how it exits:
 * normal return, thrown exception, or early `break`/`return` inside a loop.
 *
 * Every disposable type in @ydbjs/coordination implements Symbol.asyncDispose:
 *
 *   CoordinationSession  → session.close()
 *   Lease                → lease.release()   (semaphore.acquire)
 *   Lock                 → lock.release()    (mutex.lock)
 *   Leadership           → leadership.resign() (election.campaign)
 *
 * This file shows the old try/finally pattern side by side with the modern
 * `await using` equivalent so the difference is unmistakable.
 */

import { setTimeout as sleep } from 'node:timers/promises'

import { CoordinationClient } from '@ydbjs/coordination'
import { Driver } from '@ydbjs/core'

let connectionString = process.env.YDB_CONNECTION_STRING ?? 'grpc://localhost:2136/local'
let driver = new Driver(connectionString)
await driver.ready()
let client = new CoordinationClient(driver)

let utf8 = new TextEncoder()

let nodePath = '/local/resource-management-example'

// ── 1. Session lifetime ───────────────────────────────────────────────────────

// OLD WAY — you must remember to close in finally.
// If you forget, the session leaks and holds server resources.
async function oldSessionUsage(signal) {
	let session = await client.createSession(nodePath, {}, signal)
	try {
		console.log('[old] session ready, sessionId:', session.sessionId)
		// ... work ...
	} finally {
		// Easy to forget. Also: what if close() itself throws?
		await session.close()
	}
}

// NEW WAY — `await using` guarantees close() runs when the block exits.
// No try/finally, no chance to forget.
async function newSessionUsage(signal) {
	await using session = await client.createSession(nodePath, {}, signal)

	console.log('[new] session ready, sessionId:', session.sessionId)
	// ... work ...
	// session.close() called automatically here, even if an exception is thrown.
}

// ── 2. Lock / Lease lifetime ──────────────────────────────────────────────────

// OLD WAY — two nested try/finally blocks just for one lock.
// Adding more resources means deeper nesting.
async function oldLockUsage(signal) {
	let session = await client.createSession(nodePath, {}, signal)
	try {
		let mutex = session.mutex('job')
		let lock = await mutex.lock()
		try {
			console.log('[old] lock acquired, doing work')
			await sleep(200, undefined, { signal })
		} finally {
			await lock.release()
		}
	} finally {
		await session.close()
	}
}

// NEW WAY — each resource is one line. Cleanup order is guaranteed
// (innermost first): lock released, then session closed.
async function newLockUsage(signal) {
	await using session = await client.createSession(nodePath, {}, signal)
	await using _lock = await session.mutex('job').lock()

	console.log('[new] lock acquired, doing work')
	await sleep(200, undefined, { signal })
	// lock.release()  ← called automatically
	// session.close() ← called automatically, after lock is released
}

// ── 3. Error safety ───────────────────────────────────────────────────────────

// OLD WAY — if doWork() throws, the finally still runs. That is correct,
// but every developer must consciously write it. Miss the try/finally once
// and the resource leaks silently.
async function oldErrorSafety(signal) {
	let session = await client.createSession(nodePath, {}, signal)
	try {
		let lock = await session.mutex('job').lock()
		try {
			throw new Error('something went wrong mid-work')
		} finally {
			await lock.release() // runs even after the throw
		}
	} finally {
		await session.close() // also runs
	}
}

// NEW WAY — `await using` disposes automatically on exception, just as on
// normal exit. The exception propagates after disposal completes.
async function newErrorSafety(signal) {
	await using session = await client.createSession(nodePath, {}, signal)
	await using _lock = await session.mutex('job').lock()

	throw new Error('something went wrong mid-work')
	// lock.release()  ← still called
	// session.close() ← still called
	// then the error propagates to the caller
}

// ── 4. Multiple resources — where `await using` really shines ─────────────────

// OLD WAY — three resources, three levels of nesting, three finally blocks.
// This is the reality of robust resource management without language support.
async function oldMultiResource(signal) {
	let session = await client.createSession(nodePath, {}, signal)
	try {
		let lock = await session.mutex('job').lock()
		try {
			let lease = await session.semaphore('quota').acquire({ count: 1 })
			try {
				console.log('[old] all resources acquired')
				await sleep(200, undefined, { signal })
			} finally {
				await lease.release()
			}
		} finally {
			await lock.release()
		}
	} finally {
		await session.close()
	}
}

// NEW WAY — three resources, three lines. Linear. Readable.
// Disposal order is innermost-first, matching the declaration order in reverse:
// lease → lock → session.
async function newMultiResource(signal) {
	await using session = await client.createSession(nodePath, {}, signal)
	await using _lock = await session.mutex('job').lock()
	await using _lease = await session.semaphore('quota').acquire({ count: 1 })

	console.log('[new] all resources acquired')
	await sleep(200, undefined, { signal })
	// lease.release()  ← first
	// lock.release()   ← second
	// session.close()  ← last
}

// ── 5. Leadership — the most natural fit ──────────────────────────────────────

// Leadership is the clearest example of why `await using` is the right model:
// you want a hard guarantee that you resign when the block exits.
// A forgotten resign means another candidate never gets elected.

async function campaignExample(signal) {
	for await (let session of client.openSession(nodePath, { recoveryWindow: 15_000 }, signal)) {
		let election = session.election('leader')

		try {
			// campaign() blocks until this session wins.
			await using leadership = await election.campaign(utf8.encode('worker-a'))

			console.log('[leader] elected — doing leader work')
			await sleep(200, undefined, { signal: leadership.signal })

			// leadership.resign() called automatically when the block exits —
			// whether by normal return, exception, or session expiry.
		} catch (e) {
			if (session.signal.aborted) continue
			throw e
		}

		break
	}
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
	let ctrl = new AbortController()
	setTimeout(() => ctrl.abort(new Error('example timeout')), 10_000)

	try {
		await client.createNode(nodePath, {})
	} catch {
		// Node may already exist.
	}

	// Ensure semaphores used by examples exist before running them.
	try {
		await using session = await client.createSession(nodePath, {}, ctrl.signal)
		await session.semaphore('quota').create({ limit: 10 }, ctrl.signal)
	} catch {
		// May already exist.
	}

	try {
		await using session = await client.createSession(nodePath, {}, ctrl.signal)
		await session.semaphore('leader').create({ limit: 1 }, ctrl.signal)
	} catch {
		// May already exist.
	}

	try {
		console.log('\n── 1. Session lifetime ─────────────────────────────')
		await oldSessionUsage(ctrl.signal)
		await newSessionUsage(ctrl.signal)

		console.log('\n── 2. Lock / Lease lifetime ────────────────────────')
		await oldLockUsage(ctrl.signal)
		await newLockUsage(ctrl.signal)

		console.log('\n── 3. Error safety ─────────────────────────────────')
		await oldErrorSafety(ctrl.signal).catch((e) => console.log('[old] caught:', e.message))
		await newErrorSafety(ctrl.signal).catch((e) => console.log('[new] caught:', e.message))

		console.log('\n── 4. Multiple resources ───────────────────────────')
		await oldMultiResource(ctrl.signal)
		await newMultiResource(ctrl.signal)

		console.log('\n── 5. Leadership ───────────────────────────────────')
		await campaignExample(ctrl.signal)

		console.log('\nAll examples completed.')
	} finally {
		ctrl.abort()
		await client.dropNode(nodePath).catch(() => {})
		driver.close()
	}
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
