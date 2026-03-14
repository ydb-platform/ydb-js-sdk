import { CoordinationClient } from '@ydbjs/coordination'
import { Driver } from '@ydbjs/core'

let connectionString = process.env.YDB_CONNECTION_STRING ?? 'grpc://localhost:2136/local'
let driver = new Driver(connectionString)
await driver.ready()
let client = new CoordinationClient(driver)

let utf8 = new TextEncoder()
let text = new TextDecoder()

let nodePath = '/local/election-example'
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
			await using leadership = await election.campaign(utf8.encode('worker-a:starting'))

			console.log('[leader] elected — publishing endpoint')

			// Simulate startup time before the real endpoint is known.
			await sleep(300, session.signal)

			// Update leader data without re-election — all observers see it immediately.
			await leadership.proclaim(utf8.encode('worker-a:8080'))
			console.log('[leader] proclaimed endpoint: worker-a:8080')

			// Hold leadership until the session dies or external signal fires.
			await sleep(2_000, leadership.signal)

			console.log('[leader] resigning')
			// await using → resign() called automatically here
		} catch (e) {
			if (session.signal.aborted) {
				console.log('[leader] session expired, re-entering election')
				continue
			}
			throw e
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
			// observe() yields on every leader change: new leader, proclaim, or no leader.
			// state.signal aborts when the leader changes — useful for scoping work.
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
		} catch (e) {
			if (session.signal.aborted) {
				console.log('[follower] session expired, reconnecting')
				continue
			}
			throw e
		}

		break
	}

	console.log('[follower] done')
}

// ── one-shot leader query ─────────────────────────────────────────────────────

async function printCurrentLeader(signal) {
	await using session = await client.createSession(nodePath, {}, signal)
	let election = session.election(electionName)
	let leader = await election.leader(signal)

	if (leader) {
		console.log('[query] current leader:', text.decode(leader.data))
	} else {
		console.log('[query] no leader right now')
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

	// Ensure the election semaphore exists before leader and follower start.
	// observe() calls watchSemaphore which requires the semaphore to already
	// exist — if the follower races ahead of the leader's campaign() the
	// server returns NOT_FOUND.
	try {
		await using session = await client.createSession(nodePath, {}, ctrl.signal)
		await session.semaphore(electionName).create({ limit: 1 }, ctrl.signal)
	} catch {
		// May already exist — that is fine.
	}

	try {
		// Leader and follower run concurrently in the same process.
		// In a real system they would be separate worker processes.
		await Promise.all([runLeader(ctrl.signal), runFollower(ctrl.signal)])

		// One-shot snapshot query.
		await printCurrentLeader(ctrl.signal)
	} finally {
		ctrl.abort()
		await client.dropNode(nodePath).catch(() => {})
		driver.close()
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
	if (error?.message === 'example timeout') return
	console.error(error)
	process.exit(1)
})
