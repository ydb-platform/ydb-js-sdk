import { CoordinationClient } from '@ydbjs/coordination'
import { Driver } from '@ydbjs/core'

let connectionString = process.env.YDB_CONNECTION_STRING ?? 'grpc://localhost:2136/local'
let driver = new Driver(connectionString)
let client = new CoordinationClient(driver)

let utf8 = new TextEncoder()
let text = new TextDecoder()

let nodePath = '/local/shared-config-example'
let semaphoreName = 'config'

// ── publisher ─────────────────────────────────────────────────────────────────

// Publishes a new config value by updating the semaphore data field.
// All active watchers receive the update immediately.
// createSession is fine here — config publish is a one-shot operation.
async function publishConfig(config, signal) {
	await using session = await client.createSession(nodePath, {}, signal)
	let semaphore = session.semaphore(semaphoreName)
	await semaphore.update(utf8.encode(JSON.stringify(config)), signal)
	console.log('[publisher] published:', config)
}

// ── watcher ───────────────────────────────────────────────────────────────────

// Subscribes to config changes via watch({ data: true }).
// watch() yields immediately with the current value, then on every change —
// so after a session restart the latest config is always received first.
// No stale state, no missed updates.
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

	// Ensure the config semaphore exists before publishing.
	try {
		await using session = await client.createSession(nodePath, {}, ctrl.signal)
		await session
			.semaphore(semaphoreName)
			.create({ limit: 1, data: utf8.encode('{}') }, ctrl.signal)
	} catch {
		// Already exists — that is fine.
	}

	try {
		// Watcher starts first, then publisher pushes updates at intervals.
		// The watcher receives the current value immediately on connect,
		// then each subsequent update as it arrives.
		await Promise.all([watchConfig(ctrl.signal), publishUpdates(ctrl.signal)])
	} finally {
		ctrl.abort()
		await client.dropNode(nodePath).catch(() => {})
		driver.close()
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
		await sleep(500, signal)
		// oxlint-disable-next-line no-await-in-loop
		await publishConfig(config, signal)
	}
}

function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			return reject(signal.reason)
		}

		let timer = setTimeout(resolve, ms)
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(timer)
				reject(signal.reason)
			},
			{ once: true }
		)
	})
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
