import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

import { CoordinationClient } from '@ydbjs/coordination'
import { Driver } from '@ydbjs/core'

let connectionString = process.env.YDB_CONNECTION_STRING ?? 'grpc://localhost:2136/local'
let driver = new Driver(connectionString)
let client = new CoordinationClient(driver)

let utf8 = new TextEncoder()
let text = new TextDecoder()

let nodePath = `${driver.database.replace(/\/$/, '')}/shared-config-example-${randomUUID()}`
let semaphoreName = 'config'

// ── publisher ─────────────────────────────────────────────────────────────────

// Publishes a new config value by updating the semaphore data field.
// Watchers receive the current state; intermediate updates may be coalesced.
// createSession is fine here — config publish is a one-shot operation.
async function publishConfig(config, signal) {
	let session = await client.createSession(nodePath, {}, signal)
	try {
		await session.semaphore(semaphoreName).update(utf8.encode(JSON.stringify(config)), signal)
		console.log('[publisher] published:', config)
	} finally {
		try {
			await session.close(AbortSignal.timeout(5_000))
		} finally {
			session.destroy()
		}
	}
}

// ── watcher ───────────────────────────────────────────────────────────────────

// Subscribes to config changes via watch({ data: true }).
// A new watch starts with the current value; this is not an event log.
async function watchConfig(signal) {
	console.log('[watcher] starting')

	for await (let session of client.openSession(nodePath, { recoveryWindow: 15_000 }, signal)) {
		let semaphore = session.semaphore(semaphoreName)

		try {
			for await (let description of semaphore.watch({ data: true })) {
				if (!description.data.length) {
					console.log('[watcher] no config yet')
					continue
				}

				let config = JSON.parse(text.decode(description.data))
				console.log('[watcher] config updated:', config)
				if (config.version === 3) {
					return
				}
			}
			signal.throwIfAborted()
			throw new Error('Configuration watch ended before version 3 was observed')
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
	throw new Error('Configuration watch ended before version 3 was observed')
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

		let session = await client.createSession(nodePath, {}, ctrl.signal)
		try {
			await session
				.semaphore(semaphoreName)
				.create({ limit: 1, data: utf8.encode('{}') }, ctrl.signal)
		} finally {
			try {
				await session.close(AbortSignal.timeout(5_000))
			} finally {
				session.destroy()
			}
		}

		workers = [watchConfig(ctrl.signal), publishUpdates(ctrl.signal)]
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

async function publishUpdates(signal) {
	let configs = [
		{ version: 1, logLevel: 'info', timeout: 5000 },
		{ version: 2, logLevel: 'debug', timeout: 3000 },
		{ version: 3, logLevel: 'warn', timeout: 10000 },
	]

	for (let config of configs) {
		// oxlint-disable-next-line no-await-in-loop
		await sleep(500, undefined, { signal })
		// oxlint-disable-next-line no-await-in-loop
		await publishConfig(config, signal)
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
