import { beforeEach, expect, inject, onTestFinished, test } from 'vitest'

import { Driver } from '@ydbjs/core'
import { CoordinationClient, type CoordinationSession } from '@ydbjs/coordination'
import { YDBError } from '@ydbjs/error'

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
let session: CoordinationSession

beforeEach(async (ctx) => {
	let suffix = `${Date.now()}-${Math.floor(Math.random() * 0xffff).toString(16)}`
	testNodePath = `/local/test-coord-election-${suffix}`

	await client.createNode(testNodePath, {}, ctx.signal)
	session = await client.createSession(testNodePath, {}, ctx.signal)

	onTestFinished(async () => {
		session.destroy()
		await client.dropNode(testNodePath, AbortSignal.timeout(5000)).catch(() => {})
	})
})

// Election.campaign() acquires with `ephemeral` left at its default (false),
// and Election has no `create()` of its own — unlike Mutex, which always
// acquires with `ephemeral: true` and therefore self-creates. So campaigning
// only works if *something* created the underlying semaphore first. The only
// way to do that today is to reach in through `session.semaphore(name)`,
// which targets the same server-side semaphore by name.
test('rejects when campaigning against a non-existent semaphore', async (tc) => {
	let election = session.election(`election-${Date.now()}`)

	await expect(election.campaign(new Uint8Array(), tc.signal)).rejects.toBeInstanceOf(YDBError)
})

test('wins leadership after semaphore is pre-created', async (tc) => {
	let name = `election-${Date.now()}`
	await session.semaphore(name).create({ limit: 1 }, tc.signal)

	let election = session.election(name)
	let data = new TextEncoder().encode('candidate-a')

	await using leadership = await election.campaign(data, tc.signal)

	expect(leadership.signal.aborted).toBe(false)

	let leader = await election.leader(tc.signal)
	expect(Uint8Array.from(leader!.data)).toEqual(data)
})

test('releases leadership so a second candidate can win', async (tc) => {
	let name = `election-${Date.now()}`
	await session.semaphore(name).create({ limit: 1 }, tc.signal)

	let electionA = session.election(name)
	let dataA = new TextEncoder().encode('candidate-a')
	let leadershipA = await electionA.campaign(dataA, tc.signal)

	// Candidate B campaigns on the same election — must block while A leads.
	await using sessionB = await client.createSession(testNodePath, {}, tc.signal)
	let electionB = sessionB.election(name)
	let dataB = new TextEncoder().encode('candidate-b')

	let wonSecond = false
	let campaignBPromise = electionB.campaign(dataB, tc.signal).then((leadership) => {
		wonSecond = true
		return leadership
	})

	// No API exposes "request is now queued" as an awaitable event, so this
	// sleep is a heuristic, not a deterministic proof of blocking — a correct
	// implementation cannot resolve wonSecond=true within it, but a broken one
	// resolving slowly-but-wrongly could in principle race past 200ms too.
	await new Promise((resolve) => setTimeout(resolve, 200))
	expect(wonSecond).toBe(false)

	// Once A resigns, B's pending campaign must win.
	await leadershipA.resign(tc.signal)

	let leadershipB = await campaignBPromise
	expect(wonSecond).toBe(true)

	let leader = await electionB.leader(tc.signal)
	expect(Uint8Array.from(leader!.data)).toEqual(dataB)

	await leadershipB.resign(tc.signal)
})

test('returns null for a vacant pre-created semaphore', async (tc) => {
	let name = `election-${Date.now()}`
	await session.semaphore(name).create({ limit: 1 }, tc.signal)

	await expect(session.election(name).leader(tc.signal)).resolves.toBeNull()
})

test('reports the winning candidate as first leader change', async (tc) => {
	let name = `election-${Date.now()}`
	await session.semaphore(name).create({ limit: 1 }, tc.signal)

	// Start observing before anybody campaigns, so the watch subscription is
	// registered ahead of the change we're waiting to see.
	let observerElection = session.election(name)
	let states: { data: Uint8Array; isMe: boolean }[] = []

	let collecting = (async () => {
		for await (let state of observerElection.observe()) {
			states.push({ data: state.data, isMe: state.isMe })
			break
		}
	})()

	// Give observe() time to register its watch subscription before anybody
	// campaigns. observe() dedupes its very first no-owner snapshot against
	// the implicit "no leader" starting state (see election.ts's isSameLeader),
	// so nothing is yielded yet here regardless of how this sleep is timed —
	// the assertion below only holds because that first snapshot is silently
	// suppressed, not because it's observed.
	await new Promise((resolve) => setTimeout(resolve, 200))

	// Now a second session campaigns — the observer should see it appear.
	await using sessionB = await client.createSession(testNodePath, {}, tc.signal)
	let data = new TextEncoder().encode('winner')
	await using _ = await sessionB.election(name).campaign(data, tc.signal)

	await collecting

	expect(states).toHaveLength(1)
	expect(Uint8Array.from(states[0]!.data)).toEqual(data)
	expect(states[0]!.isMe).toBe(false)
})
