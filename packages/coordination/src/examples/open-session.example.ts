import type { CoordinationSession } from '../session.ts'

async function runWorker(session: CoordinationSession): Promise<void> {
	let config = session.semaphore('config')
	let leaderElection = session.election('workers/leader')
	let workerMutex = session.mutex('workers/single-run')

	for await (let state of leaderElection.observe(session.signal)) {
		if (state.isMe) {
			console.log('this session is the leader now')
		} else {
			console.log('another leader is active')
		}
	}

	await using _leadership = await leaderElection.campaign(
		new TextEncoder().encode('worker-a'),
		session.signal
	)

	console.log('leadership acquired')

	await using _lock = await workerMutex.lock(session.signal)

	console.log('exclusive section entered')

	for await (let snapshot of config.watch({ data: true }, session.signal)) {
		let value = new TextDecoder().decode(snapshot.data)
		console.log('config updated:', value)

		if (session.signal.aborted) {
			break
		}
	}
}

export async function openSessionExample(
	openSession: (signal?: AbortSignal) => AsyncIterable<CoordinationSession>,
	signal?: AbortSignal
): Promise<void> {
	for await (let session of openSession(signal)) {
		console.log('session lifecycle started', {
			sessionId: session.sessionId,
			status: session.status,
		})

		try {
			await runWorker(session)
			return
		} catch (error) {
			if (session.signal.aborted) {
				console.log('session lifecycle ended, restarting with a new session', {
					reason: session.signal.reason,
				})
				continue
			}

			throw error
		} finally {
			await session.close()
		}
	}
}
