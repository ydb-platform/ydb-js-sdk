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

async function runLeader(signal, observed, follower) {
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
				await Promise.race([observed, follower])
				signal.throwIfAborted()

				let workSignal = AbortSignal.any([session.signal, leadership.signal])
				await sleep(2_000, undefined, { signal: workSignal })

				console.log('[leader] resigning')
			} finally {
				await leadership.resign(AbortSignal.timeout(5_000))
			}
		} catch (error) {
			if (session.signal.aborted) {
				signal.throwIfAborted()
				console.log('[leader] session ended')
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

		// One leadership cycle is enough for this example.
		break
	}

	console.log('[leader] done')
}

// ── follower ──────────────────────────────────────────────────────────────────

async function runFollower(signal, onStarted, onObserved) {
	console.log('[follower] starting')
	let observedLeader = false

	for await (let session of client.openSession(nodePath, { recoveryWindow: 15_000 }, signal)) {
		let election = session.election(electionName)

		try {
			onStarted()
			// The candidate waits for onObserved before it can resign.
			for await (let state of election.observe()) {
				let endpoint = text.decode(state.data)

				if (!state.data.length) {
					console.log('[follower] no leader currently')
					if (observedLeader) {
						return
					}
					continue
				}

				observedLeader = true
				onObserved()

				if (state.isMe) {
					console.log('[follower] i am the leader:', endpoint)
				} else {
					console.log('[follower] current leader:', endpoint)
				}
			}
			signal.throwIfAborted()
			throw new Error('Election watch ended before leadership and resignation were observed')
		} catch (error) {
			if (session.signal.aborted) {
				signal.throwIfAborted()
				console.log('[follower] session ended')
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
	throw new Error('Election watch ended before leadership and resignation were observed')
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

		{
			let session = await client.createSession(nodePath, {}, ctrl.signal)
			try {
				await session.semaphore(electionName).create({ limit: 1 }, ctrl.signal)
			} finally {
				try {
					await session.close(AbortSignal.timeout(5_000))
				} finally {
					session.destroy()
				}
			}
		}

		let started = Promise.withResolvers()
		let observed = Promise.withResolvers()
		let follower = runFollower(ctrl.signal, started.resolve, observed.resolve)
		workers = [follower]
		await Promise.race([started.promise, follower])
		ctrl.signal.throwIfAborted()

		let leader = runLeader(ctrl.signal, observed.promise, follower)
		workers.push(leader)
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
