import { randomUUID } from 'node:crypto'
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
async function runWorker(endpoint, signal, onRegistered) {
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
				await waitForAbort(session.signal)
			} finally {
				await lease.release()
			}
		} catch (error) {
			if (session.signal.aborted) {
				console.log(`[worker] ${endpoint} session expired, re-registering`)
				continue
			}
			throw error
		} finally {
			await session.close()
		}

		break
	}

	console.log(`[worker] ${endpoint} unregistered`)
}

// ── endpoint watcher ──────────────────────────────────────────────────────────

// watch() reports current owners; intermediate changes may be coalesced.
async function watchEndpoints(signal) {
	console.log('[watcher] starting')

	for await (let session of client.openSession(nodePath, { recoveryWindow: 15_000 }, signal)) {
		let semaphore = session.semaphore(semaphoreName)

		try {
			for await (let description of semaphore.watch({ owners: true })) {
				let endpoints = (description.owners ?? []).map((owner) => {
					return text.decode(owner.data)
				})

				console.log('[watcher] available workers:', endpoints.length ? endpoints : '(none)')
			}
		} catch (error) {
			if (session.signal.aborted) {
				console.log('[watcher] session expired, reconnecting')
				continue
			}
			throw error
		} finally {
			await session.close()
		}

		break
	}

	console.log('[watcher] done')
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
	let ctrl = new AbortController()
	let bCtrl = new AbortController()
	let timer = setTimeout(() => {
		ctrl.abort(new Error('example timeout'))
	}, 5_000)
	let bTimer
	let workers = []
	let created = false

	try {
		await client.createNode(nodePath, {}, ctrl.signal)
		created = true

		// The watcher needs an existing ephemeral semaphore before its first describe.
		let registered = Promise.withResolvers()
		workers = [runWorker('worker-a:8080', ctrl.signal, registered.resolve)]
		await Promise.race([registered.promise, workers[0]])
		ctrl.signal.throwIfAborted()

		bTimer = setTimeout(() => {
			bCtrl.abort(new Error('worker-b stopping'))
		}, 2_000)
		workers.push(
			runWorker('worker-b:8081', AbortSignal.any([ctrl.signal, bCtrl.signal])),
			runWorker('worker-c:8082', ctrl.signal),
			watchEndpoints(ctrl.signal)
		)
		await Promise.all(workers)
	} finally {
		clearTimeout(timer)
		clearTimeout(bTimer)
		ctrl.abort()
		bCtrl.abort()
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
	await driver.ready()
	await main()
} catch (error) {
	console.error(error)
	process.exitCode = 1
} finally {
	driver.close()
}
