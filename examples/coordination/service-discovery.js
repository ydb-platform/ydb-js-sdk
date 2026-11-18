import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { CoordinationClient } from '@ydbjs/coordination'
import { Driver } from '@ydbjs/core'

let connectionString = process.env.YDB_CONNECTION_STRING ?? 'grpc://localhost:2136/local'
let driver = new Driver(connectionString)
let client = new CoordinationClient(driver)

let utf8 = new TextEncoder()
let text = new TextDecoder()

let nodePath = `${driver.database.replace(/\/$/, '')}/service-discovery-example-${randomUUID()}`
let semaphoreName = 'endpoints'

// ── worker registration ───────────────────────────────────────────────────────

// Each worker acquires one ephemeral token and attaches its endpoint as data.
// The server creates the semaphore automatically (limit = MAX_UINT64 for ephemeral).
// When the session dies — gracefully or by expiry — the token is released and
// the worker disappears from the endpoint list automatically.
async function runWorker(endpoint, signal, stop, onRegistered) {
	console.log(`[worker] ${endpoint} starting`)

	for await (let session of client.openSession(nodePath, { recoveryWindow: 15_000 }, signal)) {
		let semaphore = session.semaphore(semaphoreName)

		try {
			// ephemeral: true — no createSemaphore needed, server handles it.
			let lease = await semaphore.acquire({
				count: 1,
				data: utf8.encode(endpoint),
				ephemeral: true,
			})

			try {
				console.log(`[worker] ${endpoint} registered`)
				onRegistered?.()
				await Promise.race([stop, waitForAbort(session.signal)])
				signal.throwIfAborted()
			} finally {
				await lease.release(AbortSignal.timeout(5_000))
			}
		} catch (error) {
			if (session.signal.aborted) {
				signal.throwIfAborted()
				console.log(`[worker] ${endpoint} session expired, re-registering`)
				continue
			}
			throw error
		} finally {
			try {
				await session.close(AbortSignal.timeout(5_000))
			} finally {
				session.destroy()
			}
		}

		break
	}

	console.log(`[worker] ${endpoint} unregistered`)
}

// ── endpoint watcher ──────────────────────────────────────────────────────────

// watch() reports current owners; intermediate changes may be coalesced.
async function watchEndpoints(signal, onObservedB) {
	console.log('[watcher] starting')
	let observedB = false

	for await (let session of client.openSession(nodePath, { recoveryWindow: 15_000 }, signal)) {
		let semaphore = session.semaphore(semaphoreName)

		try {
			for await (let description of semaphore.watch({ owners: true })) {
				let endpoints = (description.owners ?? []).map((owner) => {
					return text.decode(owner.data)
				})

				console.log('[watcher] available workers:', endpoints.length ? endpoints : '(none)')
				if (endpoints.includes('worker-b:8081')) {
					observedB = true
					onObservedB()
				} else if (observedB) {
					return
				}
			}
			signal.throwIfAborted()
			throw new Error('Endpoint watch ended before worker-b removal was observed')
		} catch (error) {
			if (session.signal.aborted) {
				signal.throwIfAborted()
				console.log('[watcher] session expired, reconnecting')
				continue
			}
			throw error
		} finally {
			try {
				await session.close(AbortSignal.timeout(5_000))
			} finally {
				session.destroy()
			}
		}
	}

	signal.throwIfAborted()
	throw new Error('Endpoint watch ended before worker-b removal was observed')
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
	let ctrl = new AbortController()
	let timer = setTimeout(() => {
		ctrl.abort(new Error('example timeout'))
	}, 5_000)
	let stopWorkers = Promise.withResolvers()
	let stopB = Promise.withResolvers()
	let workers = []
	let created = false

	try {
		await driver.ready(ctrl.signal)
		await client.createNode(nodePath, {}, ctrl.signal)
		created = true

		// The watcher needs an existing ephemeral semaphore before its first describe.
		let registered = Promise.withResolvers()
		workers = [runWorker('worker-a:8080', ctrl.signal, stopWorkers.promise, registered.resolve)]
		await Promise.race([registered.promise, workers[0]])
		ctrl.signal.throwIfAborted()

		let observedB = Promise.withResolvers()
		let watcher = watchEndpoints(ctrl.signal, observedB.resolve)
		let stopTask = (async () => {
			await Promise.race([observedB.promise, watcher])
			ctrl.signal.throwIfAborted()
			await sleep(2_000, undefined, { signal: ctrl.signal })
			stopB.resolve()
		})()
		workers.push(
			runWorker('worker-b:8081', ctrl.signal, stopB.promise),
			runWorker('worker-c:8082', ctrl.signal, stopWorkers.promise),
			watcher,
			stopTask
		)

		let completed = Promise.all(workers)
		await Promise.race([watcher, completed])
		ctrl.signal.throwIfAborted()
		stopWorkers.resolve()
		await completed
		ctrl.signal.throwIfAborted()
	} finally {
		clearTimeout(timer)
		stopB.resolve()
		stopWorkers.resolve()
		ctrl.abort()
		await Promise.allSettled(workers)
		if (created) {
			await client.dropNode(nodePath, AbortSignal.timeout(5_000))
		}
	}
}

function waitForAbort(signal) {
	if (signal.aborted) {
		return Promise.reject(signal.reason)
	}

	return new Promise((_, reject) => {
		signal.addEventListener(
			'abort',
			() => {
				reject(signal.reason)
			},
			{ once: true }
		)
	})
}

try {
	await main()
} catch (error) {
	console.error(error)
	process.exitCode = 1
} finally {
	driver.close()
}
