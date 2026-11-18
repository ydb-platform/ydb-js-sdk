import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

import { CoordinationClient } from '@ydbjs/coordination'
import { Driver } from '@ydbjs/core'

let connectionString = process.env.YDB_CONNECTION_STRING ?? 'grpc://localhost:2136/local'
let driver = new Driver(connectionString)
let client = new CoordinationClient(driver)
let nodePath = `${driver.database.replace(/\/$/, '')}/resource-management-example-${randomUUID()}`
let utf8 = new TextEncoder()
let expectedFailure = new Error('something went wrong mid-work')

// Native JavaScript on Node.js 22 needs explicit cleanup; TypeScript examples can use await using.
async function sessionUsage(signal) {
	let session = await client.createSession(nodePath, {}, signal)
	try {
		console.log('[session] session ready, sessionId:', session.sessionId)
	} finally {
		await session.close()
	}
}

async function lockUsage(signal) {
	let session = await client.createSession(nodePath, {}, signal)
	try {
		let mutex = session.mutex('job')
		let lock = await mutex.lock()
		try {
			console.log('[lock] lock acquired, doing work')
			await sleep(200, undefined, { signal: session.signal })
		} finally {
			await lock.release()
		}
	} finally {
		await session.close()
	}
}

async function errorSafety(signal) {
	let session = await client.createSession(nodePath, {}, signal)
	try {
		let lock = await session.mutex('job').lock()
		try {
			throw expectedFailure
		} finally {
			await lock.release()
		}
	} finally {
		await session.close()
	}
}

async function multiResource(signal) {
	let session = await client.createSession(nodePath, {}, signal)
	try {
		let lock = await session.mutex('job').lock()
		try {
			let lease = await session.semaphore('quota').acquire({ count: 1 })
			try {
				console.log('[resources] all resources acquired')
				await sleep(200, undefined, { signal: session.signal })
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

async function campaignExample(signal) {
	for await (let session of client.openSession(nodePath, { recoveryWindow: 15_000 }, signal)) {
		try {
			let leadership = await session.election('leader').campaign(utf8.encode('worker-a'))
			try {
				console.log('[leader] elected — doing leader work')
				let workSignal = AbortSignal.any([session.signal, leadership.signal])
				await sleep(200, undefined, { signal: workSignal })
			} finally {
				await leadership.resign()
			}
		} catch (error) {
			if (session.signal.aborted) {
				continue
			}
			throw error
		} finally {
			await session.close()
		}
		break
	}
}

async function main() {
	let ctrl = new AbortController()
	let timer = setTimeout(() => {
		ctrl.abort(new Error('example timeout'))
	}, 10_000)
	let created = false

	try {
		await client.createNode(nodePath, {}, ctrl.signal)
		created = true

		let session = await client.createSession(nodePath, {}, ctrl.signal)
		try {
			await session.semaphore('quota').create({ limit: 10 }, ctrl.signal)
			await session.semaphore('leader').create({ limit: 1 }, ctrl.signal)
		} finally {
			await session.close()
		}

		console.log('Session lifetime')
		await sessionUsage(ctrl.signal)

		console.log('Lock lifetime')
		await lockUsage(ctrl.signal)

		console.log('Cleanup after an error')
		try {
			await errorSafety(ctrl.signal)
		} catch (error) {
			if (error !== expectedFailure) {
				throw error
			}
			console.log('[error] caught after releasing lock and session:', error.message)
		}

		console.log('Multiple resources')
		await multiResource(ctrl.signal)

		console.log('Leadership')
		await campaignExample(ctrl.signal)
	} finally {
		clearTimeout(timer)
		ctrl.abort()
		if (created) {
			await client.dropNode(nodePath, AbortSignal.timeout(5_000))
		}
	}
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
