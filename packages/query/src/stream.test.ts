import { expect, test, vi } from 'vitest'
import { abortable } from '@ydbjs/abortable'

import { type QueryPart, QueryStream, type QuerySummary } from './stream.ts'

function part(id = 1): QueryPart<{ id: number }> {
	return { resultSetIndex: 0, columns: [], rows: [{ id }], truncated: false }
}

test('return aborts a pending read and waits for source cleanup', async (tc) => {
	let entered = Promise.withResolvers<AbortSignal>()
	let cleanupStarted = Promise.withResolvers<void>()
	let cleanup = Promise.withResolvers<void>()
	let read = Promise.withResolvers<void>()
	let onFinish = vi.fn()
	await using stream = new QueryStream(
		async function* (signal) {
			entered.resolve(signal)
			try {
				await abortable(signal, read.promise)
				yield part()
			} finally {
				cleanupStarted.resolve()
				await cleanup.promise
			}
		},
		[tc.signal],
		onFinish
	)
	let pending = stream.next().catch((error: unknown) => error)
	let signal = await abortable(tc.signal, entered.promise)
	let closing = stream.return()
	await abortable(tc.signal, cleanupStarted.promise)
	expect(signal.aborted).toBe(true)
	expect(onFinish).not.toHaveBeenCalled()
	cleanup.resolve()
	await expect(pending).resolves.toBe(signal.reason)
	await expect(closing).resolves.toEqual({ done: true, value: undefined })
	await expect(stream.next()).resolves.toEqual({ done: true, value: undefined })
	expect(onFinish).toHaveBeenCalledTimes(1)
	expect(stream.summary).toBeUndefined()
})

test('external cancellation closes a stream paused at yield without another read', async (tc) => {
	let caller = new AbortController()
	let cleanup = Promise.withResolvers<void>()
	let finished = Promise.withResolvers<void>()
	let reason = new Error('caller cancelled')
	let onFinish = vi.fn(() => finished.resolve())
	await using stream = new QueryStream(
		async function* () {
			try {
				yield part()
			} finally {
				cleanup.resolve()
			}
		},
		[caller.signal, tc.signal],
		onFinish
	)
	await expect(stream.next()).resolves.toEqual({ done: false, value: part() })
	caller.abort(reason)
	await abortable(tc.signal, cleanup.promise)
	await abortable(tc.signal, finished.promise)
	await expect(stream.next()).rejects.toBe(reason)
	expect(onFinish).toHaveBeenCalledTimes(1)
	expect(stream.summary).toBeUndefined()
})

test('successful EOF publishes the summary and leaves subsequent reads finished', async (tc) => {
	let summary: QuerySummary = { metadata: { 'x-test': ['complete'] } }
	let onFinish = vi.fn()
	await using stream = new QueryStream(
		async function* (_signal, complete) {
			yield part()
			complete(summary)
		},
		[tc.signal],
		onFinish
	)
	expect(stream[Symbol.asyncIterator]()).toBe(stream)
	expect(stream.summary).toBeUndefined()
	await expect(stream.next()).resolves.toEqual({ done: false, value: part() })
	expect(stream.summary).toBeUndefined()
	await expect(stream.next()).resolves.toEqual({ done: true, value: undefined })
	expect(stream.summary).toBe(summary)
	await expect(stream.next()).resolves.toEqual({ done: true, value: undefined })
	await expect(stream.next()).resolves.toEqual({ done: true, value: undefined })
	await stream.return()
	expect(onFinish).toHaveBeenCalledTimes(1)
	expect(stream.summary).toBe(summary)
})

test('a failed read preserves its error on later reads and closes the source', async (tc) => {
	let failure = new Error('read failed', { cause: new Error('transport failed') })
	let cleanup = vi.fn()
	let onFinish = vi.fn()
	await using stream = new QueryStream(
		async function* () {
			try {
				yield part()
				throw failure
			} finally {
				cleanup()
			}
		},
		[tc.signal],
		onFinish
	)
	await stream.next()
	await expect(stream.next()).rejects.toBe(failure)
	await expect(stream.next()).rejects.toBe(failure)
	expect(cleanup).toHaveBeenCalledTimes(1)
	expect(onFinish).toHaveBeenCalledTimes(1)
	expect(stream.summary).toBeUndefined()
})

test('a second pending next is rejected without disturbing the active read', async (tc) => {
	let entered = Promise.withResolvers<void>()
	let read = Promise.withResolvers<void>()
	await using stream = new QueryStream(
		async function* (signal) {
			entered.resolve()
			await abortable(signal, read.promise)
			yield part()
		},
		[tc.signal]
	)
	let pending = stream.next()
	await abortable(tc.signal, entered.promise)
	await expect(stream.next()).rejects.toThrow('only one pending next()')
	read.resolve()
	await expect(pending).resolves.toEqual({ done: false, value: part() })
	await expect(stream.next()).resolves.toEqual({ done: true, value: undefined })
})

test('disposing an unstarted stream never creates its source', async () => {
	let source = vi.fn(async function* () {
		yield part()
	})
	let onFinish = vi.fn()
	let stream = new QueryStream(source, [], onFinish)
	await stream[Symbol.asyncDispose]()
	await stream[Symbol.asyncDispose]()
	await expect(stream.next()).resolves.toEqual({ done: true, value: undefined })
	expect(source).not.toHaveBeenCalled()
	expect(onFinish).toHaveBeenCalledTimes(1)
	expect(stream.summary).toBeUndefined()
})

test('a pre-aborted signal rejects before the source starts', async () => {
	let reason = new Error('already cancelled')
	let source = vi.fn(async function* () {
		yield part()
	})
	let onFinish = vi.fn()
	await using stream = new QueryStream(source, [AbortSignal.abort(reason)], onFinish)
	await expect(stream.next()).rejects.toBe(reason)
	await expect(stream.next()).rejects.toBe(reason)
	expect(source).not.toHaveBeenCalled()
	expect(onFinish).toHaveBeenCalledTimes(1)
})

test('throw aborts a pending read and preserves the supplied error', async (tc) => {
	let entered = Promise.withResolvers<AbortSignal>()
	let read = Promise.withResolvers<void>()
	let cleanup = vi.fn()
	let reason = new Error('consumer failed')
	await using stream = new QueryStream(
		async function* (signal) {
			entered.resolve(signal)
			try {
				await abortable(signal, read.promise)
				yield part()
			} finally {
				cleanup()
			}
		},
		[tc.signal]
	)
	let pending = stream.next().catch((error: unknown) => error)
	let signal = await abortable(tc.signal, entered.promise)
	await expect(stream.throw(reason)).rejects.toBe(reason)
	await expect(pending).resolves.toBe(reason)
	await expect(stream.next()).rejects.toBe(reason)
	expect(signal.reason).toBe(reason)
	expect(cleanup).toHaveBeenCalledTimes(1)
})

test('completion metadata is not published before successful generator cleanup', async (tc) => {
	let completing = Promise.withResolvers<void>()
	let cleanup = Promise.withResolvers<void>()
	let summary: QuerySummary = { metadata: { 'x-test': ['complete'] } }
	await using stream = new QueryStream(
		async function* (_signal, complete) {
			try {
				yield part()
				complete(summary)
			} finally {
				completing.resolve()
				await cleanup.promise
			}
		},
		[tc.signal]
	)
	await stream.next()
	let ending = stream.next()
	await abortable(tc.signal, completing.promise)
	let prematureSummary = stream.summary
	cleanup.resolve()
	await expect(ending).resolves.toEqual({ done: true, value: undefined })
	expect(prematureSummary).toBeUndefined()
	expect(stream.summary).toBe(summary)
})

test('failed generator cleanup does not expose a successful summary', async (tc) => {
	let failure = new Error('cleanup failed')
	let summary: QuerySummary = { metadata: { 'x-test': ['complete'] } }
	await using stream = new QueryStream(
		async function* (_signal, complete) {
			try {
				yield part()
				complete(summary)
			} finally {
				await Promise.reject(failure)
			}
		},
		[tc.signal]
	)
	await stream.next()
	await expect(stream.next()).rejects.toBe(failure)
	expect(stream.summary).toBeUndefined()
})
