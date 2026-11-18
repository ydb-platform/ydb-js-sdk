import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

import { CoordinationClient } from '@ydbjs/coordination'
import { Driver } from '@ydbjs/core'

let connectionString = process.env.YDB_CONNECTION_STRING ?? 'grpc://localhost:2136/local'
let driver = new Driver(connectionString)
let client = new CoordinationClient(driver)

let utf8 = new TextEncoder()
let text = new TextDecoder()

let nodePath = `${driver.database.replace(/\/$/, '')}/election-example-${randomUUID()}`
let electionName = 'api-leader'

// ── leader ────────────────────────────────────────────────────────────────────

async function runLeader(signal) {
	console.log('[leader] starting')

	for await (let session of client.openSession(nodePath, { recoveryWindow: 15_000 }, signal)) {
		let election = session.election(electionName)

		try {
			console.log('[leader] campaigning...')

			// campaign() blocks until this session wins the election.
			// Only one session can hold the token at a time.
			let leadership = await election.campaign(utf8.encode('worker-a:8080'))

			try {
				console.log('[leader] elected: worker-a:8080')
				await printCurrentLeader(session.signal)

				let workSignal = AbortSignal.any([session.signal, leadership.signal])
				await sleep(2_000, undefined, { signal: workSignal })

				console.log('[leader] resigning')
			} finally {
				await leadership.resign()
			}
		} catch (error) {
			if (session.signal.aborted) {
				console.log('[leader] session ended')
				continue
			}
			throw error
		} finally {
			await session.close()
		}

		// One leadership cycle is enough for this example.
		break
	}

	console.log('[leader] done')
}

// ── follower ──────────────────────────────────────────────────────────────────

async function runFollower(signal) {
	console.log('[follower] starting')

	for await (let session of client.openSession(nodePath, { recoveryWindow: 15_000 }, signal)) {
		let election = session.election(electionName)

		try {
			// Owner changes are observed only while the iterator keeps advancing.
			for await (let state of election.observe()) {
				let endpoint = text.decode(state.data)

				if (!state.data.length) {
					console.log('[follower] no leader currently')
					continue
				}

				if (state.isMe) {
					console.log('[follower] i am the leader:', endpoint)
				} else {
					console.log('[follower] current leader:', endpoint)
				}
			}
		} catch (error) {
			if (session.signal.aborted) {
				console.log('[follower] session ended')
				continue
			}
			throw error
		} finally {
			await session.close()
		}

		break
	}

	console.log('[follower] done')
}

// ── one-shot leader query ─────────────────────────────────────────────────────

async function printCurrentLeader(signal) {
	let session = await client.createSession(nodePath, {}, signal)

	try {
		let leader = await session.election(electionName).leader(signal)
		if (leader) {
			console.log('[query] current leader:', text.decode(leader.data))
		} else {
			console.log('[query] no leader right now')
		}
	} finally {
		await session.close()
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
		await client.createNode(nodePath, {}, ctrl.signal)
		created = true

		{
			let session = await client.createSession(nodePath, {}, ctrl.signal)
			try {
				await session.semaphore(electionName).create({ limit: 1 }, ctrl.signal)
			} finally {
				await session.close()
			}
		}

		workers = [runLeader(ctrl.signal), runFollower(ctrl.signal)]
		await Promise.all(workers)
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
	await driver.ready()
	await main()
} catch (error) {
	console.error(error)
	process.exitCode = 1
} finally {
	driver.close()
}
