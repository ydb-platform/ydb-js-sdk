import { CoordinationClient } from '@ydbjs/coordination'
import { Driver } from '@ydbjs/core'

let connectionString = process.env.YDB_CONNECTION_STRING ?? 'grpc://localhost:2136/local'
let driver = new Driver(connectionString)
let client = new CoordinationClient(driver)

let utf8 = new TextEncoder()
let text = new TextDecoder()

let nodePath = '/local/service-discovery-example'
let semaphoreName = 'endpoints'

// ── worker registration ───────────────────────────────────────────────────────

// Each worker acquires one ephemeral token and attaches its endpoint as data.
// The server creates the semaphore automatically (limit = MAX_UINT64 for ephemeral).
// When the session dies — gracefully or by expiry — the token is released and
// the worker disappears from the endpoint list automatically.
async function runWorker(endpoint, signal) {
	console.log(`[worker] ${endpoint} starting`)

	for await (let session of client.openSession(nodePath, { recoveryWindow: 15_000 }, signal)) {
		let semaphore = session.semaphore(semaphoreName)

		try {
			// ephemeral: true — no createSemaphore needed, server handles it.
			await using lease = await semaphore.acquire({
				count: 1,
				data: utf8.encode(endpoint),
				ephemeral: true,
			})

			console.log(`[worker] ${endpoint} registered`)

			// Hold registration until the session dies or external signal fires.
			await waitForAbort(lease.signal)

			// await using → lease.release() called here.
			// The endpoint disappears from the owners list immediately.
		} catch {
			if (session.signal.aborted) {
				console.log(`[worker] ${endpoint} session expired, re-registering`)
				continue
			}
			throw error
		}

		break
	}

	console.log(`[worker] ${endpoint} unregistered`)
}

// ── endpoint watcher ──────────────────────────────────────────────────────────

// watch() yields immediately with the current owner list, then on every change.
// When the session restarts after expiry, the latest state is delivered again —
// no stale data, no missed updates.
async function watchEndpoints(signal) {
	console.log('[watcher] starting')

	for await (let session of client.openSession(nodePath, { recoveryWindow: 15_000 }, signal)) {
		let semaphore = session.semaphore(semaphoreName)

		try {
			for await (let description of semaphore.watch({ owners: true })) {
				let endpoints = (description.owners ?? []).map((o) => text.decode(o.data))

				console.log('[watcher] available workers:', endpoints.length ? endpoints : '(none)')
			}
		} catch {
			if (session.signal.aborted) {
				console.log('[watcher] session expired, reconnecting')
				continue
			}
			throw error
		}

		break
	}

	console.log('[watcher] done')
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
	let ctrl = new AbortController()

	// Stop everything after 5 seconds.
	setTimeout(() => ctrl.abort(new Error('example timeout')), 5_000)

	try {
		await client.createNode(nodePath, {})
	} catch {
		// Node may already exist — that is fine.
	}

	try {
		// Three workers register concurrently. The watcher observes the live list.
		// After 2 seconds, worker-b is stopped to demonstrate automatic deregistration.
		let bCtrl = new AbortController()
		setTimeout(() => bCtrl.abort(new Error('worker-b stopping')), 2_000)

		await Promise.all([
			runWorker('worker-a:8080', ctrl.signal),
			runWorker('worker-b:8081', bCtrl.signal),
			runWorker('worker-c:8082', ctrl.signal),
			watchEndpoints(ctrl.signal),
		])
	} finally {
		ctrl.abort()
		await client.dropNode(nodePath).catch(() => {})
		driver.close()
	}
}

function waitForAbort(signal) {
	if (signal.aborted) {
		return Promise.resolve()
	}

	return new Promise((resolve) => {
		signal.addEventListener('abort', resolve, { once: true })
	})
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
