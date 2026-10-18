import { EventEmitter } from 'node:events'
import { setImmediate } from 'node:timers/promises'

import { expect, test, vi } from 'vitest'

import { type TopicWorker, runTopicWorkers } from './topic-workers.ts'

// Emitted lifecycle events make worker exit and result ordering deterministic.
class TestWorker extends EventEmitter implements TopicWorker {
	messages: unknown[] = []
	terminations = 0

	postMessage(message: unknown): void {
		this.messages.push(message)
	}

	async terminate(): Promise<number> {
		this.terminations++
		return 0
	}
}

let options = { partitions: 1, writerCount: 1, drainTimeoutMs: 2000 }
let checkpoint = { accepted: [10], acknowledged: [10] }
let summary = {
	complete: true,
	failureCount: 0,
	producers: [{ accepted: 10, acknowledged: 10, delivered: 10, committed: 10 }],
}
let writerResult = { type: 'result', success: true, checkpoint, reconnects: 0 }
let readerResult = { type: 'result', success: true, summary, reconnects: 0 }

test('stops the writer before forwarding its final checkpoint to the reader', async () => {
	let read = new TestWorker()
	let write = new TestWorker()
	let stop = new AbortController()
	let completion = runTopicWorkers({ read, write: [write] }, options, stop.signal)

	write.emit('message', { type: 'checkpoint', checkpoint })
	expect(read.messages).toEqual([{ type: 'checkpoint', checkpoint, final: false }])
	expect(write.messages).toEqual([])

	stop.abort()
	expect(write.messages).toEqual([{ type: 'stop' }])
	expect(read.messages).toHaveLength(1)

	write.emit('message', writerResult)
	expect(read.messages).toEqual([
		{ type: 'checkpoint', checkpoint, final: false },
		{ type: 'checkpoint', checkpoint, final: true },
	])

	write.emit('exit', 0)
	read.emit('message', readerResult)
	read.emit('exit', 0)

	let result = await completion
	expect(result).toEqual({ read: readerResult, write: [writerResult] })
})

test('starts the writer drain when stop was requested before supervision', async () => {
	let read = new TestWorker()
	let write = new TestWorker()
	let completion = runTopicWorkers({ read, write: [write] }, options, AbortSignal.abort())

	expect(write.messages).toEqual([{ type: 'stop' }])
	expect(read.messages).toEqual([])

	write.emit('message', writerResult)
	write.emit('exit', 0)
	read.emit('message', readerResult)
	read.emit('exit', 0)

	let result = await completion
	expect(result.read.summary).toEqual(summary)
	expect(result.write[0]!.checkpoint).toEqual(checkpoint)
})

test('fails a clean worker exit without a result and terminates its peer', async (tc) => {
	let read = new TestWorker()
	let write = new TestWorker()
	let completion = runTopicWorkers({ read, write: [write] }, options, tc.signal)

	read.emit('exit', 0)

	await expect(completion).rejects.toThrow('read exited without a successful result')
	expect(read.terminations).toBe(1)
	expect(write.terminations).toBe(1)
})

test('rejects a writer result before producer stop', async (tc) => {
	let read = new TestWorker()
	let write = new TestWorker()
	let completion = runTopicWorkers({ read, write: [write] }, options, tc.signal)

	write.emit('message', writerResult)

	await expect(completion).rejects.toThrow('write finished before producer stop')
})

test('rejects a reader result before the final writer checkpoint', async () => {
	let read = new TestWorker()
	let write = new TestWorker()
	let completion = runTopicWorkers({ read, write: [write] }, options, AbortSignal.abort())

	read.emit('message', readerResult)

	await expect(completion).rejects.toThrow('Reader finished before final writer checkpoint')
})

test('rejects a second result from the same worker', async () => {
	let read = new TestWorker()
	let write = new TestWorker()
	let completion = runTopicWorkers({ read, write: [write] }, options, AbortSignal.abort())

	write.emit('message', writerResult)
	write.emit('message', writerResult)

	await expect(completion).rejects.toThrow('write sent a second result')
})

test('keeps failure after a later successful result and clean exit', async () => {
	let read = new TestWorker()
	let write = new TestWorker()
	let completion = runTopicWorkers({ read, write: [write] }, options, AbortSignal.abort())

	write.emit('message', { type: 'result', success: false, error: 'integrity failure' })
	write.emit('message', writerResult)
	write.emit('exit', 0)
	read.emit('message', readerResult)
	read.emit('exit', 0)

	await expect(completion).rejects.toThrow('write: integrity failure')
})

test('preserves an uncaught worker error and terminates its peer', async (tc) => {
	let read = new TestWorker()
	let write = new TestWorker()
	let failure = new Error('worker crashed')
	let completion = runTopicWorkers({ read, write: [write] }, options, tc.signal)

	write.emit('error', failure)
	write.emit('exit', 1)

	await expect(completion).rejects.toBe(failure)
	expect(read.terminations).toBe(1)
	expect(write.terminations).toBe(1)
})

test('rejects a nonzero writer exit after its successful checkpoint', async () => {
	let read = new TestWorker()
	let write = new TestWorker()
	let completion = runTopicWorkers({ read, write: [write] }, options, AbortSignal.abort())

	write.emit('message', writerResult)
	write.emit('exit', 7)

	await expect(completion).rejects.toThrow('write exited with code 7')
})

test('rejects a nonzero reader exit after its successful result', async () => {
	let read = new TestWorker()
	let write = new TestWorker()
	let completion = runTopicWorkers({ read, write: [write] }, options, AbortSignal.abort())

	write.emit('message', writerResult)
	write.emit('exit', 0)
	read.emit('message', readerResult)
	read.emit('exit', 7)

	await expect(completion).rejects.toThrow('read exited with code 7')
})

test('waits for clean exits after both workers report success', async (tc) => {
	let read = new TestWorker()
	let write = new TestWorker()
	let completion = runTopicWorkers({ read, write: [write] }, options, AbortSignal.abort())
	let completed = false
	let result = completion.then((value) => {
		completed = true
		return value
	})

	write.emit('message', writerResult)
	read.emit('message', readerResult)
	write.emit('exit', 0)
	await setImmediate(undefined, { signal: tc.signal })

	expect(completed).toBe(false)
	expect(read.terminations).toBe(0)

	read.emit('exit', 0)
	await result
	expect(completed).toBe(true)
})

test('rejects a final checkpoint without acknowledgments', async () => {
	let read = new TestWorker()
	let write = new TestWorker()
	let incomplete = { accepted: [10], acknowledged: [9] }
	let completion = runTopicWorkers({ read, write: [write] }, options, AbortSignal.abort())

	write.emit('message', { ...writerResult, checkpoint: incomplete })

	await expect(completion).rejects.toThrow('Writer did not acknowledge every accepted message')
	expect(read.messages).toEqual([])
})

test('rejects a final checkpoint with an idle producer', async () => {
	let read = new TestWorker()
	let write = new TestWorker()
	let empty = { accepted: [0], acknowledged: [0] }
	let completion = runTopicWorkers({ read, write: [write] }, options, AbortSignal.abort())

	write.emit('message', { ...writerResult, checkpoint: empty })

	await expect(completion).rejects.toThrow('Writer did not acknowledge every accepted message')
})

test('rejects a result without its final checkpoint', async () => {
	let read = new TestWorker()
	let write = new TestWorker()
	let completion = runTopicWorkers({ read, write: [write] }, options, AbortSignal.abort())

	write.emit('message', { type: 'result', success: true, reconnects: 0 })

	await expect(completion).rejects.toThrow('Writer did not acknowledge every accepted message')
})

test('rejects an acknowledged tail that the reader did not commit', async () => {
	let read = new TestWorker()
	let write = new TestWorker()
	let incomplete = {
		...summary,
		producers: [{ accepted: 10, acknowledged: 10, delivered: 10, committed: 9 }],
	}
	let completion = runTopicWorkers({ read, write: [write] }, options, AbortSignal.abort())

	write.emit('message', writerResult)
	write.emit('exit', 0)
	read.emit('message', { ...readerResult, summary: incomplete })
	read.emit('exit', 0)

	await expect(completion).rejects.toThrow('Reader did not reconcile the final writer checkpoint')
})

test('rejects a successful reader result without its summary', async () => {
	let read = new TestWorker()
	let write = new TestWorker()
	let completion = runTopicWorkers({ read, write: [write] }, options, AbortSignal.abort())

	write.emit('message', writerResult)
	write.emit('exit', 0)
	read.emit('message', { type: 'result', success: true, reconnects: 0 })
	read.emit('exit', 0)

	await expect(completion).rejects.toThrow('Reader did not reconcile the final writer checkpoint')
})

test('terminates both workers when the reader never finishes its drain', async () => {
	vi.useFakeTimers()
	try {
		let read = new TestWorker()
		let write = new TestWorker()
		let completion = runTopicWorkers({ read, write: [write] }, options, AbortSignal.abort())
		let outcome = completion.catch((error: unknown) => error)

		write.emit('message', writerResult)
		write.emit('exit', 0)
		await vi.advanceTimersByTimeAsync(options.drainTimeoutMs)

		let failure = await outcome
		expect(failure).toEqual(new Error('Topic workers exceeded the drain deadline'))
		expect(read.terminations).toBe(1)
		expect(write.terminations).toBe(1)
	} finally {
		vi.useRealTimers()
	}
})

test('combines disjoint checkpoints and relays commits to every writer', async () => {
	let read = new TestWorker()
	let first = new TestWorker()
	let second = new TestWorker()
	let stop = new AbortController()
	let settings = { ...options, partitions: 3, writerCount: 2 }
	let completion = runTopicWorkers({ read, write: [first, second] }, settings, stop.signal)
	let firstCheckpoint = { accepted: [10, 0, 30], acknowledged: [10, 0, 30] }
	let secondCheckpoint = { accepted: [0, 20, 0], acknowledged: [0, 20, 0] }
	let committed = { type: 'committed', counts: [1, 2, 3] }

	read.emit('message', committed)
	expect(first.messages).toEqual([committed])
	expect(second.messages).toEqual([committed])

	first.emit('message', { type: 'checkpoint', checkpoint: firstCheckpoint })
	second.emit('message', { type: 'checkpoint', checkpoint: secondCheckpoint })
	expect(read.messages).toEqual([
		{ type: 'checkpoint', checkpoint: firstCheckpoint, final: false },
		{
			type: 'checkpoint',
			checkpoint: { accepted: [10, 20, 30], acknowledged: [10, 20, 30] },
			final: false,
		},
	])

	stop.abort()
	expect(first.messages).toEqual([committed, { type: 'stop' }])
	expect(second.messages).toEqual([committed, { type: 'stop' }])

	let firstResult = { ...writerResult, checkpoint: firstCheckpoint, reconnects: 2 }
	let secondResult = { ...writerResult, checkpoint: secondCheckpoint, reconnects: 3 }
	second.emit('message', secondResult)
	second.emit('exit', 0)
	first.emit('message', firstResult)
	first.emit('exit', 0)

	expect(read.messages.at(-2)).toEqual({
		type: 'checkpoint',
		checkpoint: { accepted: [10, 20, 30], acknowledged: [10, 20, 30] },
		final: false,
	})
	expect(read.messages.at(-1)).toEqual({
		type: 'checkpoint',
		checkpoint: { accepted: [10, 20, 30], acknowledged: [10, 20, 30] },
		final: true,
	})

	let producers = [10, 20, 30].map((count) => ({
		accepted: count,
		acknowledged: count,
		delivered: count,
		committed: count,
	}))
	read.emit('message', { ...readerResult, summary: { ...summary, producers } })
	read.emit('exit', 0)

	let result = await completion
	expect(result.write).toEqual([firstResult, secondResult])
	expect(result.read.summary?.producers).toEqual(producers)
})

test('rejects writers claiming the same partitions', async () => {
	let read = new TestWorker()
	let first = new TestWorker()
	let second = new TestWorker()
	let settings = { ...options, partitions: 2, writerCount: 2 }
	let completion = runTopicWorkers(
		{ read, write: [first, second] },
		settings,
		AbortSignal.abort()
	)
	let overlapping = { accepted: [10, 10], acknowledged: [10, 10] }

	first.emit('message', { ...writerResult, checkpoint: overlapping })

	await expect(completion).rejects.toThrow('Writer did not acknowledge every accepted message')
	expect(read.terminations).toBe(1)
	expect(first.terminations).toBe(1)
	expect(second.terminations).toBe(1)
})

test('rejects a reader result while another writer has not finished', async () => {
	let read = new TestWorker()
	let first = new TestWorker()
	let second = new TestWorker()
	let settings = { ...options, partitions: 2, writerCount: 2 }
	let completion = runTopicWorkers(
		{ read, write: [first, second] },
		settings,
		AbortSignal.abort()
	)
	let firstCheckpoint = { accepted: [10, 0], acknowledged: [10, 0] }

	first.emit('message', { ...writerResult, checkpoint: firstCheckpoint })
	first.emit('exit', 0)
	read.emit('message', readerResult)

	await expect(completion).rejects.toThrow('Reader finished before final writer checkpoint')
	expect(second.terminations).toBe(1)
})
