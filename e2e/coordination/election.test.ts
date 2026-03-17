import { beforeEach, expect, inject, onTestFinished, test } from 'vitest'

import { Driver } from '@ydbjs/core'
import { CoordinationClient, type CoordinationSession } from '@ydbjs/coordination'

// #region setup
declare module 'vitest' {
	export interface ProvidedContext {
		connectionString: string
	}
}

let driver = new Driver(inject('connectionString'), {
	'ydb.sdk.enable_discovery': false,
})

await driver.ready()

let client = new CoordinationClient(driver)

let testNodePath: string
let electionName: string
let sessionA: CoordinationSession

beforeEach(async () => {
	let suffix = `${Date.now()}-${Math.floor(Math.random() * 0xffff).toString(16)}`
	testNodePath = `/local/test-coord-elec-${suffix}`
	electionName = `election-${suffix}`

	await client.createNode(testNodePath, {}, AbortSignal.timeout(5000))
	sessionA = await client.createSession(testNodePath, {}, AbortSignal.timeout(5000))

	// Election is backed by a regular semaphore with limit=1.
	// The semaphore must exist before any campaign or observe call.
	await sessionA.semaphore(electionName).create({ limit: 1 }, AbortSignal.timeout(5000))

	onTestFinished(async () => {
		await sessionA.close(AbortSignal.timeout(5000)).catch(() => {})
		await client.dropNode(testNodePath, AbortSignal.timeout(5000)).catch(() => {})
	})
})
// #endregion

test('leader returns null when no leader exists', async () => {
	let election = sessionA.election(electionName)

	let info = await election.leader(AbortSignal.timeout(5000))

	expect(info).toBeNull()
})

test('campaign becomes leader', async () => {
	let election = sessionA.election(electionName)
	let payload = Buffer.from('candidate-A')

	await using _leadership = await election.campaign(payload, AbortSignal.timeout(5000))

	let info = await election.leader(AbortSignal.timeout(5000))

	expect(info).not.toBeNull()
	expect(Buffer.from(info!.data)).toEqual(payload)
})

test('resign releases leadership', async () => {
	let election = sessionA.election(electionName)

	let leadership = await election.campaign(Buffer.from('A'), AbortSignal.timeout(5000))
	await leadership.resign(AbortSignal.timeout(5000))

	let info = await election.leader(AbortSignal.timeout(5000))

	expect(info).toBeNull()
})

test('async dispose resigns', async () => {
	let election = sessionA.election(electionName)

	{
		await using _leadership = await election.campaign(
			Buffer.from('A'),
			AbortSignal.timeout(5000)
		)
	}

	// After dispose the semaphore is free — a second campaign must succeed immediately
	await using leadership2 = await election.campaign(Buffer.from('A2'), AbortSignal.timeout(5000))

	expect(leadership2.signal.aborted).toBe(false)
})

test('proclaim updates semaphore data', async () => {
	// proclaim calls updateSemaphore which writes the semaphore-level data field.
	// That is separate from the owner-level acquire data stored at campaign time.
	let election = sessionA.election(electionName)

	await using _leadership = await election.campaign(
		Buffer.from('initial'),
		AbortSignal.timeout(5000)
	)

	await _leadership.proclaim(Buffer.from('updated'), AbortSignal.timeout(5000))

	// Read the semaphore's top-level data field — that is what proclaim writes to.
	let description = await sessionA.semaphore(electionName).describe({}, AbortSignal.timeout(5000))

	expect(Buffer.from(description.data)).toEqual(Buffer.from('updated'))
})

test('second campaign waits until first leader resigns', async () => {
	await using sessionB = await client.createSession(testNodePath, {}, AbortSignal.timeout(5000))

	let electionA = sessionA.election(electionName)
	let electionB = sessionB.election(electionName)

	// Session A becomes leader
	await using leadershipA = await electionA.campaign(Buffer.from('A'), AbortSignal.timeout(5000))

	// Session B starts campaigning — it blocks until A resigns
	let campaignB = electionB.campaign(Buffer.from('B'), AbortSignal.timeout(10000))

	// Let B's request reach the server before A resigns
	await new Promise((resolve) => setTimeout(resolve, 200))

	await leadershipA.resign(AbortSignal.timeout(5000))

	await using _leadershipB = await campaignB

	let info = await electionB.leader(AbortSignal.timeout(5000))

	expect(info).not.toBeNull()
	expect(Buffer.from(info!.data)).toEqual(Buffer.from('B'))
})

test('observe detects when a leader appears', async () => {
	// sessionA observes, sessionB campaigns — separate sessions keep request
	// registries independent so the watch and the acquire do not interfere.
	await using sessionB = await client.createSession(testNodePath, {}, AbortSignal.timeout(5000))

	let ctrl = new AbortController()
	let observedData: Buffer[] = []

	let observing = (async () => {
		for await (let state of sessionA
			.election(electionName)
			.observe(AbortSignal.any([ctrl.signal, AbortSignal.timeout(10000)]))) {
			observedData.push(Buffer.from(state.data))
			ctrl.abort()
			break
		}
	})()

	// Give the watch stream time to register with the server before campaigning
	await new Promise((resolve) => setTimeout(resolve, 200))

	await using _leadership = await sessionB
		.election(electionName)
		.campaign(Buffer.from('leader-B'), AbortSignal.timeout(5000))

	await observing

	expect(observedData).toHaveLength(1)
	expect(observedData[0]).toEqual(Buffer.from('leader-B'))
})

test('observe sets isMe true when the observing session is the leader', async () => {
	let election = sessionA.election(electionName)

	// Campaign first so the first watch snapshot already has an owner
	await using _leadership = await election.campaign(
		Buffer.from('leader-A'),
		AbortSignal.timeout(5000)
	)

	let firstState: { isMe: boolean; data: Buffer } | undefined

	for await (let state of election.observe(AbortSignal.timeout(5000))) {
		firstState = { isMe: state.isMe, data: Buffer.from(state.data) }
		break
	}

	expect(firstState).toBeDefined()
	expect(firstState!.isMe).toBe(true)
	expect(firstState!.data).toEqual(Buffer.from('leader-A'))
})

test('observe tracks leader change and no-leader transition', async () => {
	// Three sessions: A = initial leader, B = dedicated observer, C = second leader.
	// Keeping observe and campaign on separate sessions avoids request registry conflicts.
	await using sessionB = await client.createSession(testNodePath, {}, AbortSignal.timeout(5000))
	await using sessionC = await client.createSession(testNodePath, {}, AbortSignal.timeout(5000))

	// A becomes leader before observation starts so the first snapshot is non-empty
	await using leadershipA = await sessionA
		.election(electionName)
		.campaign(Buffer.from('A'), AbortSignal.timeout(5000))

	let states: Array<{ data: Buffer; isMe: boolean }> = []

	let observing = (async () => {
		for await (let state of sessionB
			.election(electionName)
			.observe(AbortSignal.timeout(15000))) {
			states.push({ data: Buffer.from(state.data), isMe: state.isMe })
			// Collect: A is leader → no leader → C is leader
			if (states.length >= 3) break
		}
	})()

	// Give the watch stream time to register before triggering changes
	await new Promise((resolve) => setTimeout(resolve, 200))

	// A resigns → observe yields no-leader state
	await leadershipA.resign(AbortSignal.timeout(5000))

	// Small pause so the server sends the no-leader notification as its own event
	// before C acquires — otherwise the two changes may arrive in one batch.
	await new Promise((resolve) => setTimeout(resolve, 200))

	// C campaigns → observe yields C-is-leader state
	await using _leadershipC = await sessionC
		.election(electionName)
		.campaign(Buffer.from('C'), AbortSignal.timeout(5000))

	await observing

	// State 1: A is leader (observed by B, so isMe=false)
	expect(states[0]!.data).toEqual(Buffer.from('A'))
	expect(states[0]!.isMe).toBe(false)

	// State 2: no leader
	expect(states[1]!.data).toHaveLength(0)
	expect(states[1]!.isMe).toBe(false)

	// State 3: C is leader (observed by B, so isMe=false)
	expect(states[2]!.data).toEqual(Buffer.from('C'))
	expect(states[2]!.isMe).toBe(false)
})

test('observe ends gracefully when signal is already aborted', async () => {
	let election = sessionA.election(electionName)
	let ctrl = new AbortController()
	ctrl.abort()

	let iterations = 0

	// When the signal is already aborted the underlying watchSemaphore may throw
	// the abort reason before yielding.  Both outcomes are acceptable — the
	// important contract is that no items are yielded.
	try {
		for await (let _ of election.observe(ctrl.signal)) {
			iterations++
		}
	} catch {
		// AbortError propagated from watchSemaphore — expected and intentionally ignored
	}

	expect(iterations).toBe(0)
})

test('leadership signal aborts when leader resigns', async () => {
	let election = sessionA.election(electionName)

	let leadership = await election.campaign(Buffer.from('A'), AbortSignal.timeout(5000))

	// Signal must be alive while holding leadership
	expect(leadership.signal.aborted).toBe(false)

	await leadership.resign(AbortSignal.timeout(5000))

	// After resign the underlying lease is released — signal must abort
	expect(leadership.signal.aborted).toBe(true)
})

test('leader state signal aborts when the leader changes', async () => {
	// A campaigns. B observes and collects two states: A-is-leader → no-leader.
	// When observe yields the second state, it aborts the first state's signal.
	await using sessionB = await client.createSession(testNodePath, {}, AbortSignal.timeout(5000))

	await using leadershipA = await sessionA
		.election(electionName)
		.campaign(Buffer.from('A'), AbortSignal.timeout(5000))

	let capturedSignal: AbortSignal | undefined

	let observing = (async () => {
		for await (let state of sessionB
			.election(electionName)
			.observe(AbortSignal.timeout(10000))) {
			if (!capturedSignal) {
				// First state: A is leader — capture the signal and keep iterating
				capturedSignal = state.signal
				continue
			}
			// Second state arrived: first state's signal must be aborted now
			break
		}
	})()

	// Give the watch stream time to register before triggering the change
	await new Promise((resolve) => setTimeout(resolve, 200))

	// A resigns — observe yields the second state (no leader), aborting the first state's signal
	await leadershipA.resign(AbortSignal.timeout(5000))

	await observing

	expect(capturedSignal).toBeDefined()
	expect(capturedSignal!.aborted).toBe(true)
})
