import type { CoordinationSession, Election, Mutex, Semaphore } from '../index.ts'
import type { CoordinationSessionOptions } from '../runtime/session-options.ts'

let utf8 = new TextEncoder()
let text = new TextDecoder()

type SessionExampleOptions = Omit<CoordinationSessionOptions, 'path'> & {
	path?: string
}

export type SessionExampleApi = {
	createSession(
		options?: SessionExampleOptions,
		signal?: AbortSignal
	): Promise<CoordinationSession>
	openSession(
		options?: SessionExampleOptions,
		signal?: AbortSignal
	): AsyncIterable<CoordinationSession>
}

export async function runCreateSessionExample(
	api: SessionExampleApi,
	signal?: AbortSignal
): Promise<void> {
	let session = await api.createSession(
		{
			path: '/local/coordination/example',
			description: 'v2 one-shot example',
			recoveryWindow: 30_000,
		},
		signal
	)

	try {
		console.log('[createSession] status:', session.status)
		console.log('[createSession] sessionId:', session.sessionId)

		let semaphore = session.semaphore('config')
		await ensureSemaphore(semaphore, signal)

		let snapshot = await semaphore.describe({ owners: true, waiters: true }, signal)
		console.log('[createSession] snapshot:', stringify(snapshot))

		let mutex = session.mutex('migration-lock')
		await using lock = await mutex.lock(signal)
		await doCriticalWork('migration', lock.signal)

		let election = session.election('leader')
		await using leadership = await election.campaign(utf8.encode('worker-a'), signal)
		await leadership.proclaim(utf8.encode('worker-a-ready'), signal)

		let leader = await election.leader(signal)
		console.log('[createSession] leader:', leader ? text.decode(leader.data) : '<none>')
	} finally {
		await session.close(signal)
	}
}

export async function runOpenSessionExample(
	api: SessionExampleApi,
	signal?: AbortSignal
): Promise<void> {
	for await (let session of api.openSession(
		{
			path: '/local/coordination/example',
			description: 'v2 worker example',
			recoveryWindow: 30_000,
		},
		signal
	)) {
		console.log('[openSession] new lifecycle started')
		console.log('[openSession] status:', session.status)
		console.log('[openSession] sessionId:', session.sessionId)

		try {
			await runWorkerIteration(session, signal)
		} catch (error) {
			if (session.signal.aborted) {
				console.log(
					'[openSession] session lifecycle finished:',
					formatReason(session.signal.reason)
				)
				continue
			}

			throw error
		}

		if (signal?.aborted) {
			break
		}
	}
}

async function runWorkerIteration(
	session: CoordinationSession,
	signal?: AbortSignal
): Promise<void> {
	let semaphore = session.semaphore('service-config')
	let mutex = session.mutex('singleton-job')
	let election = session.election('leader')

	await ensureSemaphore(semaphore, signal)

	let watchTask = observeConfig(semaphore, session.signal)
	let workerTask = runLeaderAwareWorker(mutex, election, session.signal)

	try {
		await Promise.race([watchTask, workerTask])
	} finally {
		await Promise.allSettled([watchTask, workerTask])
	}
}

async function ensureSemaphore(semaphore: Semaphore, signal?: AbortSignal): Promise<void> {
	try {
		await semaphore.create(
			{
				limit: 1,
				data: utf8.encode('initial-config'),
			},
			signal
		)
	} catch {
		// The example tolerates already existing semaphore state.
	}
}

async function observeConfig(semaphore: Semaphore, signal: AbortSignal): Promise<void> {
	for await (let description of semaphore.watch({ data: true, owners: true }, signal)) {
		console.log('[watch] config update:', text.decode(description.data))
		console.log('[watch] owners:', description.owners?.length ?? 0)

		if (signal.aborted) {
			return
		}
	}
}

async function runLeaderAwareWorker(
	mutex: Mutex,
	election: Election,
	signal: AbortSignal
): Promise<void> {
	await using leadership = await election.campaign(utf8.encode('worker-a'), signal)

	// oxlint-disable-next-line no-await-in-loop
	while (!signal.aborted && !leadership.signal.aborted) {
		// oxlint-disable-next-line no-await-in-loop
		await using lock = await mutex.lock(leadership.signal)
		// oxlint-disable-next-line no-await-in-loop
		await doCriticalWork('leader-iteration', lock.signal)
		// oxlint-disable-next-line no-await-in-loop
		await leadership.proclaim(utf8.encode(`worker-a:${Date.now()}`), leadership.signal)

		// oxlint-disable-next-line no-await-in-loop
		await delay(1_000, leadership.signal)
	}
}

async function doCriticalWork(name: string, signal: AbortSignal): Promise<void> {
	console.log(`[work] started: ${name}`)

	try {
		await delay(250, signal)
		console.log(`[work] completed: ${name}`)
	} catch (error) {
		if (signal.aborted) {
			console.log(`[work] aborted: ${name} (${formatReason(signal.reason)})`)
			return
		}

		throw error
	}
}

function stringify(value: unknown): string {
	return JSON.stringify(
		value,
		(_key, currentValue) => {
			if (typeof currentValue === 'bigint') {
				return currentValue.toString()
			}

			if (currentValue instanceof Uint8Array) {
				return text.decode(currentValue)
			}

			return currentValue
		},
		2
	)
}

function formatReason(reason: unknown): string {
	if (reason instanceof Error) {
		return reason.message
	}

	return String(reason)
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason)
			return
		}

		let timer = setTimeout(() => {
			cleanup()
			resolve()
		}, ms)

		let onAbort = () => {
			clearTimeout(timer)
			cleanup()
			reject(signal?.reason ?? new Error('The operation was aborted'))
		}

		let cleanup = () => {
			signal?.removeEventListener('abort', onAbort)
		}

		signal?.addEventListener('abort', onAbort, { once: true })
	})
}
