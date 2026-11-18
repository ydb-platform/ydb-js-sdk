import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

import { CoordinationClient } from '@ydbjs/coordination'
import { Driver } from '@ydbjs/core'

let connectionString = process.env.YDB_CONNECTION_STRING ?? 'grpc://localhost:2136/local'
let driver = new Driver(connectionString)
let client = new CoordinationClient(driver)

let nodePath = `${driver.database.replace(/\/$/, '')}/mutex-example-${randomUUID()}`
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

			let lock = await mutex.lock()
			try {
				console.log(`[worker-${id}] lock acquired — doing exclusive work`)
				let workSignal = AbortSignal.any([session.signal, lock.signal])
				await sleep(500, undefined, { signal: workSignal })
				console.log(`[worker-${id}] work done, releasing`)
			} finally {
				await lock.release(AbortSignal.timeout(5_000))
			}
		} catch (error) {
			if (session.signal.aborted) {
				signal.throwIfAborted()
				console.log(`[worker-${id}] session expired, retrying`)
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

	console.log(`[worker-${id}] done`)
}

// ── tryLock() — non-blocking attempt ─────────────────────────────────────────

// tryLock() returns null immediately if the mutex is already held
// instead of blocking. Useful for optional work or fast-path checks.
async function tryWork(signal) {
	let session = await client.createSession(nodePath, {}, signal)
	try {
		let lock = await session.mutex(mutexName).tryLock(signal)
		if (!lock) {
			console.log('[tryLock] mutex is busy — skipping optional work')
			return
		}

		try {
			console.log('[tryLock] lock acquired — doing optional work')
			let workSignal = AbortSignal.any([session.signal, lock.signal])
			await sleep(200, undefined, { signal: workSignal })
			console.log('[tryLock] optional work done')
		} finally {
			await lock.release(AbortSignal.timeout(5_000))
		}
	} finally {
		try {
			await session.close(AbortSignal.timeout(5_000))
		} finally {
			session.destroy()
		}
	}
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
	let ctrl = new AbortController()
	let timer = setTimeout(() => {
		ctrl.abort(new Error('example timeout'))
	}, 5_000)
	let workers = []
	let created = false

	try {
		await driver.ready(ctrl.signal)
		await client.createNode(nodePath, {}, ctrl.signal)
		created = true
		workers = [runWorker('a', ctrl.signal), runWorker('b', ctrl.signal), tryWork(ctrl.signal)]
		await Promise.all(workers)
		ctrl.signal.throwIfAborted()
	} finally {
		clearTimeout(timer)
		ctrl.abort()
		await Promise.allSettled(workers)
		if (created) {
			await client.dropNode(nodePath, AbortSignal.timeout(5_000))
		}
	}
}

try {
	await main()
} catch (error) {
	console.error(error)
	process.exitCode = 1
} finally {
	driver.close()
}
