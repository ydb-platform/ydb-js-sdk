import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { expect, test } from 'vitest'

import { runTopicWorkers } from './topic-workers.ts'

let data = {
	runId: 'test',
	topic: 'test',
	consumer: 'test',
	partitions: 1,
	messageBytes: 64,
	rps: 100,
	maxPendingMessages: 1000,
	writerCount: 1,
	codec: 'raw',
	drainTimeoutMs: 2000,
	stallTimeoutMs: 2000,
	params: {},
}
let checkpoint = { accepted: [10], acknowledged: [10] }
let summary = {
	complete: true,
	failureCount: 0,
	producers: [{ accepted: 10, acknowledged: 10, delivered: 10, committed: 10 }],
}
let writer = `
import { parentPort } from 'node:worker_threads'
parentPort.on('message', ({ type }) => {
	if (type !== 'stop') throw new Error('Unexpected writer control')
	parentPort.postMessage({ type: 'checkpoint', checkpoint: ${JSON.stringify(checkpoint)} })
	parentPort.postMessage({ type: 'result', success: true, checkpoint: ${JSON.stringify(checkpoint)}, reconnects: 0 })
	parentPort.close()
})`
let reader = `
import { parentPort } from 'node:worker_threads'
let progress = false
parentPort.on('message', (message) => {
	if (message.type !== 'checkpoint') throw new Error('Reader stopped before the final writer checkpoint')
	if (!message.final) { progress = true; return }
	if (!progress || message.checkpoint.accepted[0] !== 10) throw new Error('Missing writer progress')
	parentPort.postMessage({ type: 'result', success: true, summary: ${JSON.stringify(summary)}, reconnects: 0 })
	parentPort.close()
})`

// Scripted workers make exit/checkpoint races deterministic without replacing the coordinator.
let fixture = async (read = reader, write = writer) => {
	let directory = await mkdtemp(path.join(tmpdir(), 'topic-workers-'))
	await writeFile(path.join(directory, 'read.mjs'), read)
	await writeFile(path.join(directory, 'write.mjs'), write)
	return {
		urls: {
			read: pathToFileURL(path.join(directory, 'read.mjs')),
			write: pathToFileURL(path.join(directory, 'write.mjs')),
		},
		[Symbol.asyncDispose]: () => rm(directory, { recursive: true, force: true }),
	}
}

test('forwards checkpoints and drains both workers when stop precedes their startup', async () => {
	await using files = await fixture()
	let results = await runTopicWorkers(files.urls, data, AbortSignal.abort())
	expect(results.read.summary).toEqual(summary)
	expect(results.write[0]!.checkpoint).toEqual(checkpoint)
})

test('fails when a worker exits without a result', async () => {
	await using files = await fixture('process.exit(0)')
	await expect(runTopicWorkers(files.urls, data, AbortSignal.abort())).rejects.toThrow(
		'without a successful result'
	)
})

test('rejects a writer result before the controller requests stop', async (tc) => {
	await using files = await fixture(
		reader,
		`import { parentPort } from 'node:worker_threads'; parentPort.postMessage({ type: 'result', success: true })`
	)
	await expect(runTopicWorkers(files.urls, data, tc.signal)).rejects.toThrow(
		'before producer stop'
	)
})

test('rejects an acknowledged tail that the reader did not commit', async () => {
	await using files = await fixture(reader.replace('"committed":10', '"committed":9'))
	await expect(runTopicWorkers(files.urls, data, AbortSignal.abort())).rejects.toThrow(
		'did not reconcile'
	)
})

test('keeps failure when a worker subsequently reports success', async () => {
	await using files = await fixture(
		reader,
		writer.replace(
			"parentPort.postMessage({ type: 'checkpoint'",
			"parentPort.postMessage({ type: 'result', success: false, error: 'integrity failure' }); parentPort.postMessage({ type: 'checkpoint'"
		)
	)
	await expect(runTopicWorkers(files.urls, data, AbortSignal.abort())).rejects.toThrow(
		'integrity failure'
	)
})

test('terminates a reader that never finishes its drain', async () => {
	await using files = await fixture(
		"import { parentPort } from 'node:worker_threads'; parentPort.on('message', () => {})"
	)
	await expect(runTopicWorkers(files.urls, data, AbortSignal.abort())).rejects.toThrow(
		'drain deadline'
	)
})

test('rejects a nonzero writer exit after its successful final checkpoint', async () => {
	await using files = await fixture(
		reader,
		writer.replace('parentPort.close()', 'process.exit(7)')
	)
	await expect(runTopicWorkers(files.urls, data, AbortSignal.abort())).rejects.toThrow('code 7')
})

test('rejects a final writer checkpoint with missing acknowledgments', async () => {
	await using files = await fixture(
		reader,
		writer.replaceAll('"acknowledged":[10]', '"acknowledged":[9]')
	)
	await expect(runTopicWorkers(files.urls, data, AbortSignal.abort())).rejects.toThrow(
		'did not acknowledge'
	)
})

test('combines disjoint producer checkpoints and relays reader commits to every producer', async () => {
	let write = `
import { parentPort, workerData } from 'node:worker_threads'
let stopped = false
let committed = false
function finish() {
	if (!stopped || !committed) return
	let counts = workerData.writerIndex === 0 ? [10, 0, 30] : [0, 20, 0]
	let checkpoint = { accepted: counts, acknowledged: counts }
	parentPort.postMessage({ type: 'checkpoint', checkpoint })
	parentPort.postMessage({ type: 'result', success: true, checkpoint, reconnects: 0 })
	parentPort.close()
}
parentPort.on('message', (message) => {
	if (message.type === 'stop') stopped = true
	if (message.type === 'committed') {
		if (JSON.stringify(message.counts) !== '[1,2,3]') throw new Error('Lost partition commits')
		committed = true
	}
	finish()
})`
	let read = `
import { parentPort } from 'node:worker_threads'
parentPort.postMessage({ type: 'committed', counts: [1, 2, 3] })
parentPort.on('message', (message) => {
	if (!message.final) return
	if (JSON.stringify(message.checkpoint.accepted) !== '[10,20,30]') throw new Error('Missing producer')
	let producers = [10, 20, 30].map((count) => ({ accepted: count, acknowledged: count, delivered: count, committed: count }))
	parentPort.postMessage({ type: 'result', success: true, reconnects: 0, summary: { complete: true, failureCount: 0, producers } })
	parentPort.close()
})`
	await using files = await fixture(read, write)
	let results = await runTopicWorkers(
		files.urls,
		{ ...data, partitions: 3, writerCount: 2 },
		AbortSignal.abort()
	)
	expect(results.write).toHaveLength(2)
	expect(results.read.summary?.producers.map((producer) => producer.committed)).toEqual([
		10, 20, 30,
	])
})

test('rejects two producer workers claiming the same partitions', async () => {
	await using files = await fixture(reader, writer.replaceAll('[10]', '[10,10]'))
	await expect(
		runTopicWorkers(files.urls, { ...data, partitions: 2, writerCount: 2 }, AbortSignal.abort())
	).rejects.toThrow('Writer did not acknowledge every accepted message')
})
