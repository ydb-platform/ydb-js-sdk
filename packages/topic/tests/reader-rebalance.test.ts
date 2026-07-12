import { subscribe, unsubscribe } from 'node:diagnostics_channel'

import { create } from '@bufbuild/protobuf'
import { afterEach, beforeEach, expect, inject, test } from 'vitest'

import {
	CreateTopicRequestSchema,
	DropTopicRequestSchema,
	TopicServiceDefinition,
} from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'

import { type TopicReader, createTopicReader } from '../src/reader/index.js'
import { createTopicWriter } from '../src/writer/index.js'

// First real-server rebalance coverage. A second read session on the same consumer
// makes the server's read balancer move a partition away from the first session
// (stop_partition_session_request) — the production trigger for the reader FSM's
// graceful-stop path. The unit / contract tests drive that path with a scripted
// server; this locks in what the live server actually does.

let driver = new Driver(inject('connectionString'), { 'ydb.sdk.enable_discovery': false })
await driver.ready()
let topicService = driver.createClient(TopicServiceDefinition)

let topic: string
let consumer: string

beforeEach(async () => {
	topic = `reader-rebalance-${Date.now()}`
	consumer = `consumer-${Date.now()}`
	await topicService.createTopic(
		create(CreateTopicRequestSchema, {
			path: topic,
			partitioningSettings: { minActivePartitions: 2n, maxActivePartitions: 2n },
			consumers: [{ name: consumer }],
		})
	)
})

afterEach(async () => {
	await topicService.dropTopic(create(DropTopicRequestSchema, { path: topic })).catch(() => {})
})

// Subscribe to an event channel and gather its payloads; `using` auto-unsubscribes.
let capture = function capture<T = unknown>(name: string): { payloads: T[] } & Disposable {
	let payloads: T[] = []
	let fn = (message: unknown) => payloads.push(message as T)
	subscribe(name, fn)
	return {
		payloads,
		[Symbol.dispose]() {
			unsubscribe(name, fn)
		},
	}
}

let waitUntil = async function waitUntil(predicate: () => boolean, ms: number): Promise<boolean> {
	let started = Date.now()
	while (Date.now() - started < ms) {
		if (predicate()) return true
		// oxlint-disable-next-line no-await-in-loop
		await new Promise((resolve) => setTimeout(resolve, 200))
	}
	return predicate()
}

// Every commit() must settle — a hung commit is the failure mode this test guards
// against. Handlers are attached immediately so a rejection is never unhandled.
type CommitOutcome = { state: 'pending' | 'resolved' | 'rejected'; reason?: unknown }

let trackCommit = function trackCommit(outcomes: CommitOutcome[], promise: Promise<void>): void {
	let outcome: CommitOutcome = { state: 'pending' }
	outcomes.push(outcome)
	promise.then(
		() => Object.assign(outcome, { state: 'resolved' as const }),
		(reason: unknown) => Object.assign(outcome, { state: 'rejected' as const, reason })
	)
}

let decoder = new TextDecoder()

// Read continuously, committing every delivered batch (so a rebalance races real
// in-flight commits), collecting per-message ids for the at-least-once check.
let runReadLoop = function runReadLoop(
	reader: TopicReader,
	received: Set<number>,
	commits: CommitOutcome[],
	errorBox: { error?: unknown },
	signal: AbortSignal
): void {
	void (async () => {
		try {
			for await (let batch of reader.read({ batchWindowMs: 200, signal })) {
				for (let message of batch) {
					received.add(Number(decoder.decode(message.payload)))
				}
				if (batch.length > 0) {
					trackCommit(commits, reader.commit(batch))
				}
			}
		} catch (error) {
			errorBox.error = error
		}
	})()
}

test(
	'moves a partition to a second reader on the same consumer',
	{ timeout: 60_000 },
	async (tc) => {
		let encoder = new TextEncoder()

		// One writer pinned to each partition so traffic keeps flowing to both sides of
		// the rebalance for the whole test.
		await using writer0 = createTopicWriter(driver, { topic, producer: 'p0', partitionId: 0n })
		await using writer1 = createTopicWriter(driver, { topic, producer: 'p1', partitionId: 1n })

		let written = new Set<number>()
		let nextId = 0
		let writeRound = async function writeRound(): Promise<void> {
			let a = nextId++
			let b = nextId++
			writer0.write(encoder.encode(String(a)))
			writer1.write(encoder.encode(String(b)))
			written.add(a)
			written.add(b)
			await Promise.all([writer0.flush(), writer1.flush()])
		}

		// Record which partitions the server stops on reader A and how (graceful vs
		// forced). The dc channel is the only place the stop reason surfaces.
		let stopsA: bigint[] = []
		using stopEvents = capture<{ partitionId: bigint; reason: 'graceful' | 'lost' | 'ended' }>(
			'ydb:topic.reader.partition.stopped'
		)

		let receivedA = new Set<number>()
		let receivedB = new Set<number>()
		let commits: CommitOutcome[] = []
		let errA: { error?: unknown } = {}
		let errB: { error?: unknown } = {}

		await using readerA = createTopicReader(driver, {
			topic,
			consumer,
			onPartitionSessionStop: async (session) => {
				stopsA.push(session.partitionId)
			},
		})
		runReadLoop(readerA, receivedA, commits, errA, tc.signal)

		// Reader A owns both partitions first: it must have consumed traffic from both
		// before B joins, otherwise there is nothing to rebalance away.
		await writeRound()
		expect(await waitUntil(() => receivedA.size >= written.size, 20_000)).toBe(true)

		await using readerB = createTopicReader(driver, { topic, consumer })
		runReadLoop(readerB, receivedB, commits, errB, tc.signal)

		// Keep traffic flowing until the balancer reacts: A loses a partition and B
		// starts delivering. Continuous writes also keep commits in flight across the
		// stop, which is exactly the race the graceful-stop path must survive.
		let rebalanced = await (async () => {
			let deadline = Date.now() + 30_000
			while (Date.now() < deadline) {
				// oxlint-disable-next-line no-await-in-loop
				await writeRound()
				if (stopsA.length > 0 && receivedB.size > 0) return true
				// oxlint-disable-next-line no-await-in-loop
				await new Promise((resolve) => setTimeout(resolve, 500))
			}
			return stopsA.length > 0 && receivedB.size > 0
		})()
		expect(rebalanced, 'server moved a partition from A to B and B delivers').toBe(true)

		// At-least-once across the pair: one more round, then every written id must have
		// been delivered to A or B (dupes across the handover are fine, gaps are not).
		await writeRound()
		let covered = await waitUntil(() => {
			for (let id of written) {
				if (!receivedA.has(id) && !receivedB.has(id)) return false
			}
			return true
		}, 25_000)
		expect(covered, 'combined delivery covers every written message').toBe(true)

		// Neither reader may error terminally over a rebalance.
		expect(errA.error).toBeUndefined()
		expect(errB.error).toBeUndefined()

		// Every commit() settles — resolved, or rejected with the documented
		// reassign-race errors. A pending commit here means a hang.
		let settled = await waitUntil(() => commits.every((c) => c.state !== 'pending'), 10_000)
		expect(settled, 'every commit() promise settled').toBe(true)
		let documentedRejection =
			/reassigned before commit was acknowledged|stopped or expired partition session|No active partition/
		let undocumentedRejections = commits
			.filter((outcome) => outcome.state === 'rejected')
			.map((outcome) => String((outcome.reason as Error).message))
			.filter((message) => !documentedRejection.test(message))
		expect(undocumentedRejections).toEqual([])

		// The rebalance stop must surface through the dc channel too. The local server
		// consistently stops the moved partition gracefully (reason 'graceful', after the
		// commit drain); 'lost' (forced) is still a legal server choice, so it is not
		// asserted — only that the stop was observed at all.
		expect(stopEvents.payloads.length).toBeGreaterThan(0)
	}
)
