import { setTimeout as sleep } from 'node:timers/promises'

import { CoordinationClient } from '@ydbjs/coordination'
import { Driver } from '@ydbjs/core'

let connectionString = process.env.YDB_CONNECTION_STRING ?? 'grpc://localhost:2136/local'
let driver = new Driver(connectionString)
await driver.ready()
let client = new CoordinationClient(driver)

let nodePath = '/local/mutex-example'
let mutexName = 'job-lock'

// ── worker using lock() ───────────────────────────────────────────────────────

// lock() blocks until the mutex is acquired.
// The ephemeral semaphore is created automatically by the server —
// no prior createSemaphore call needed.
async function runWorker(id, signal) {
	console.log(`[worker-${id}] starting`)

	for await (let session of client.openSession(nodePath, { recoveryWindow: 15_000 }, signal)) {
		let mutex = session.mutex(mutexName)

		try {
			console.log(`[worker-${id}] waiting for lock`)

			await using lock = await mutex.lock()

			console.log(`[worker-${id}] lock acquired — doing exclusive work`)
			await sleep(500, undefined, { signal: lock.signal })
			console.log(`[worker-${id}] work done, releasing`)

			// await using → lock.release() called automatically here
		} catch {
			if (session.signal.aborted) {
				console.log(`[worker-${id}] session expired, retrying`)
				continue
			}
			throw error
		}

		break
	}

	console.log(`[worker-${id}] done`)
}

// ── tryLock() — non-blocking attempt ─────────────────────────────────────────

// tryLock() returns null immediately if the mutex is already held
// instead of blocking. Useful for optional work or fast-path checks.
async function tryWork(signal) {
	await using session = await client.createSession(nodePath, {}, signal)
	let mutex = session.mutex(mutexName)

	let lock = await mutex.tryLock(signal)

	if (!lock) {
		console.log('[tryLock] mutex is busy — skipping optional work')
		return
	}

	try {
		console.log('[tryLock] lock acquired — doing optional work')
		await sleep(200, undefined, { signal: lock.signal })
		console.log('[tryLock] optional work done')
	} finally {
		await lock.release()
	}
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
		// Two workers compete for the same mutex — only one runs at a time.
		// tryLock runs in parallel: it will miss since a worker holds the lock.
		await Promise.all([
			runWorker('a', ctrl.signal),
			runWorker('b', ctrl.signal),
			tryWork(ctrl.signal),
		])
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
