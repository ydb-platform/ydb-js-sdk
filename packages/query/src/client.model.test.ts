import { channel } from 'node:diagnostics_channel'

import { abortable } from '@ydbjs/abortable'
import type { Driver } from '@ydbjs/core'
import { type OperationOptions, QueryClient, type QueryStream } from '@ydbjs/query'
import { expect, test } from 'vitest'

import { onAbort, resultPart, startClientServer } from './client.fixtures.ts'
import { SessionAbortedError } from './session.ts'

test.for(['session-body', 'transaction-body', 'transaction-precommit'] as const)(
	'caller cancellation releases SDK resources while %s ignores its signal',
	async (stage, tc) => {
		using server = await startClientServer()
		using client = new QueryClient(server.driver, { poolOptions: { maxSize: 1 } })
		let caller = new AbortController()
		let entered = Promise.withResolvers<void>()
		let release = Promise.withResolvers<void>()
		let finished = Promise.withResolvers<void>()
		let body = async () => {
			entered.resolve()
			try {
				await release.promise
			} finally {
				finished.resolve()
			}
		}
		let options = { signal: caller.signal }
		let operation =
			stage === 'session-body'
				? client.retrySession(options, body)
				: client.retryTransaction(options, async (tx) => {
						if (stage === 'transaction-precommit') tx.beforeCommit(body)
						else await body()
					})
		let failure = operation.catch((error: unknown) => error)
		try {
			await abortable(tc.signal, entered.promise)
			let reason = new Error('caller stopped waiting')
			caller.abort(reason)
			expect(await failure).toBe(reason)
			await abortable(tc.signal, client.close())
			expect(server.commits).toHaveLength(0)
			expect(server.rollbacks).toHaveLength(stage === 'session-body' ? 0 : 1)
			expect(server.deleted).toHaveLength(1)
		} finally {
			release.resolve()
			await finished.promise
			await failure
		}
	}
)

function observePool(driver: Driver) {
	let events: string[] = []
	let acquired: string[] = []
	let released: string[] = []
	let waiting = Promise.withResolvers<void>()
	let subscriptions = [
		['acquired', (id: string) => acquired.push(id)],
		['released', (id: string) => released.push(id)],
		['waiter.enqueued', () => waiting.resolve()],
		['pool.closed', () => {}],
	] as const
	let detach = subscriptions.map(([name, record]) => {
		let source = channel(`ydb:query.session.${name}`)
		let listener = (message: unknown) => {
			let event = message as { driver: unknown; sessionId: string }
			if (event.driver !== driver.identity) return
			events.push(name)
			record(event.sessionId)
		}
		source.subscribe(listener)
		return () => source.unsubscribe(listener)
	})
	return {
		events,
		acquired,
		released,
		waiting: waiting.promise,
		[Symbol.dispose]() {
			for (let unsubscribe of detach) unsubscribe()
		},
	}
}

function holdStream(client: QueryClient, options: OperationOptions) {
	let ready = Promise.withResolvers<QueryStream<{ id: number }>>()
	let release = Promise.withResolvers<void>()
	let finished = Promise.withResolvers<void>()
	let attempts = 0
	let outcome = client
		.retrySession(options, async (executor) => {
			attempts++
			ready.resolve(executor.stream<{ id: number }>('held'))
			try {
				await release.promise
				return 'completed'
			} finally {
				finished.resolve()
			}
		})
		.catch((error: unknown) => error)
	return {
		ready: ready.promise,
		outcome,
		finished: finished.promise,
		release: () => release.resolve(),
		get attempts() {
			return attempts
		},
	}
}

for (let state of ['unstarted', 'pending', 'paused'] as const) {
	for (let action of ['return', 'abort', 'destroy'] as const) {
		test(`stream lifetime model: ${state} -> ${action} -> closed`, async (tc) => {
			let entered = Promise.withResolvers<void>()
			let stopped = Promise.withResolvers<void>()
			let caller = new AbortController()
			let reason = new Error('caller ended the operation')
			using server = await startClientServer({
				async *executeQuery(_request, context) {
					entered.resolve()
					try {
						if (state === 'paused') yield resultPart([1])
						await onAbort(context.signal)
					} finally {
						stopped.resolve()
					}
				},
			})
			using trace = observePool(server.driver)
			using client = new QueryClient(server.driver, { poolOptions: { maxSize: 1 } })
			let held = holdStream(client, {
				signal: caller.signal,
				idempotent: true,
				retry: { budget: 3, strategy: 0 },
			})
			let stream = await abortable(tc.signal, held.ready)
			let first: Promise<unknown> | undefined
			let published: number[] = []
			try {
				if (state !== 'unstarted') {
					first = stream.next().then(
						(part) => {
							if (!part.done) published.push(...part.value.rows.map((row) => row.id))
							return part
						},
						(error: unknown) => error
					)
					await abortable(tc.signal, entered.promise)
					if (state === 'paused') await first
				}

				trace.events.push(action)
				if (action === 'return') await abortable(tc.signal, stream.return())
				else if (action === 'abort') caller.abort(reason)
				else client.destroy()

				let firstOutcome = await first
				let nextOutcome = await abortable(
					tc.signal,
					stream.next().catch((error: unknown) => error)
				)
				if (action === 'return') held.release()
				let outcome = await abortable(tc.signal, held.outcome)
				if (state !== 'unstarted') await abortable(tc.signal, stopped.promise)
				await abortable(tc.signal, client.close())
				let expectedReason = action === 'abort' ? reason : client.signal.reason
				let endedAsRequested =
					action === 'return'
						? (nextOutcome as IteratorResult<unknown>).done
						: state === 'unstarted'
							? nextOutcome instanceof Error
							: nextOutcome === expectedReason
				let pendingReadPreservedReason =
					state !== 'pending' ||
					(action === 'return'
						? firstOutcome instanceof Error && firstOutcome.name === 'AbortError'
						: firstOutcome === expectedReason)
				let lifecycle = trace.events.filter(
					(event) =>
						event === 'acquired' ||
						event === 'released' ||
						event === action ||
						event === 'pool.closed'
				)

				expect(endedAsRequested).toBe(true)
				expect(pendingReadPreservedReason).toBe(true)
				expect(published).toEqual(state === 'paused' ? [1] : [])
				expect(server.executions).toHaveLength(state === 'unstarted' ? 0 : 1)
				expect(held.attempts).toBe(1)
				let incomplete = expect.objectContaining({
					message: expect.stringMatching(/closed before completion/i),
				})
				let expectedOutcome =
					action !== 'return'
						? expectedReason
						: state === 'unstarted'
							? 'completed'
							: incomplete
				let preservesCancellation = action === 'return' || outcome === expectedReason
				expect(outcome).toEqual(expectedOutcome)
				expect(outcome instanceof Error).toBe(action !== 'return' || state !== 'unstarted')
				expect(outcome).not.toBeInstanceOf(SessionAbortedError)
				expect(preservesCancellation).toBe(true)
				expect(trace.acquired).toHaveLength(1)
				expect(trace.released).toEqual(trace.acquired)
				expect(lifecycle).toEqual(
					action === 'destroy'
						? ['acquired', action, 'pool.closed', 'released']
						: ['acquired', action, 'released', 'pool.closed']
				)
			} finally {
				held.release()
				await abortable(tc.signal, held.finished)
			}
		})
	}
}

for (let state of ['pending', 'paused'] as const) {
	test(`session death closes a ${state} scoped stream without another consumer read`, async (tc) => {
		let entered = Promise.withResolvers<string>()
		let stopped = Promise.withResolvers<void>()
		using server = await startClientServer({
			async *executeQuery(request, context) {
				entered.resolve(request.sessionId)
				try {
					if (state === 'paused') yield resultPart([1])
					await onAbort(context.signal)
				} finally {
					stopped.resolve()
				}
			},
		})
		using trace = observePool(server.driver)
		using client = new QueryClient(server.driver, { poolOptions: { maxSize: 1 } })
		let held = holdStream(client, { signal: tc.signal, retry: { budget: 1 } })
		let stream = await abortable(tc.signal, held.ready)
		let reading = stream.next().catch((error: unknown) => error)
		try {
			let session = await abortable(tc.signal, entered.promise)
			if (state === 'paused') await reading

			server.breakSession(session)
			await abortable(tc.signal, stopped.promise)
			held.release()
			let operationFailure = await abortable(tc.signal, held.outcome)
			await abortable(tc.signal, client.close())
			let readOutcome = await reading

			expect(operationFailure).toBeInstanceOf(SessionAbortedError)
			let failedRead = expect.any(SessionAbortedError)
			let deliveredRead = expect.objectContaining({
				done: false,
				value: expect.objectContaining({ rows: [{ id: 1 }] }),
			})
			expect(readOutcome).toEqual(state === 'pending' ? failedRead : deliveredRead)
			expect(held.attempts).toBe(1)
			expect(server.executions).toHaveLength(1)
			expect(trace.acquired).toEqual([session])
			expect(trace.released).toEqual([session])
			expect(trace.events).toEqual(['acquired', 'released', 'pool.closed'])
		} finally {
			held.release()
			await abortable(tc.signal, held.finished)
		}
	})
}

test('close drains a paused accepted stream and rejects new operations', async (tc) => {
	let continueReading = Promise.withResolvers<void>()
	using server = await startClientServer({
		async *executeQuery(_request, context) {
			yield resultPart([1])
			await abortable(context.signal, continueReading.promise)
			yield resultPart([2])
		},
	})
	using trace = observePool(server.driver)
	using client = new QueryClient(server.driver, { poolOptions: { maxSize: 1 } })
	let held = holdStream(client, { signal: tc.signal, retry: { budget: 1 } })
	let stream = await abortable(tc.signal, held.ready)
	try {
		let first = await stream.next()
		let closed = false
		let closing = client.close().then(() => {
			closed = true
			return undefined
		})
		let rejected = await client
			.retrySession((session) => session.execute('late'))
			.catch((error: unknown) => error)

		expect(rejected).toMatchObject({ name: 'SessionPoolClosedError' })
		expect(closed).toBe(false)
		expect(trace.released).toEqual([])
		continueReading.resolve()
		let second = await stream.next()
		let eof = await stream.next()
		held.release()
		expect(await abortable(tc.signal, held.outcome)).toBe('completed')
		await abortable(tc.signal, closing)

		expect(first.value?.rows).toEqual([{ id: 1 }])
		expect(second.value?.rows).toEqual([{ id: 2 }])
		expect(eof.done).toBe(true)
		expect(server.executions).toHaveLength(1)
		expect(trace.released).toEqual(trace.acquired)
		expect(server.deleted).toEqual(trace.acquired)
	} finally {
		continueReading.resolve()
		held.release()
		await abortable(tc.signal, held.finished)
	}
})

test('returning a held stream releases a queued sibling onto a fresh session', async (tc) => {
	let stopped = Promise.withResolvers<void>()
	using server = await startClientServer({
		async *executeQuery(request, context) {
			if (request.query.case === 'queryContent' && request.query.value.text === 'sibling') {
				yield resultPart([2])
				return
			}
			try {
				yield resultPart([1])
				await onAbort(context.signal)
			} finally {
				stopped.resolve()
			}
		},
	})
	using trace = observePool(server.driver)
	using client = new QueryClient(server.driver, { poolOptions: { maxSize: 1 } })
	let held = holdStream(client, {
		signal: tc.signal,
		idempotent: true,
		retry: { budget: 3, strategy: 0 },
	})
	let stream = await abortable(tc.signal, held.ready)
	try {
		await stream.next()
		let sibling = client.retrySession(
			{
				signal: tc.signal,
			},
			(session) => session.execute('sibling')
		)
		await abortable(tc.signal, trace.waiting)

		expect(server.executions).toHaveLength(1)
		await stream.return()
		held.release()
		let failure = await abortable(tc.signal, held.outcome)
		let result = await sibling
		await abortable(tc.signal, stopped.promise)
		await abortable(tc.signal, client.close())

		expect(result.resultSets[0]?.rows).toEqual([{ id: 2 }])
		expect(failure).toMatchObject({
			message: expect.stringMatching(/closed before completion/i),
		})
		expect(held.attempts).toBe(1)
		expect(server.executions).toHaveLength(2)
		expect(server.executions[1]!.sessionId).not.toBe(server.executions[0]!.sessionId)
		expect(trace.acquired).toHaveLength(2)
		expect(trace.released).toEqual(trace.acquired)
	} finally {
		held.release()
		await abortable(tc.signal, held.finished)
	}
})

test('destroy releases a callback lease while its consumer remains blocked', async (tc) => {
	let entered = Promise.withResolvers<void>()
	let continueCallback = Promise.withResolvers<void>()
	let callbackFinished = Promise.withResolvers<void>()
	let stopped = Promise.withResolvers<void>()
	using server = await startClientServer({
		async *executeQuery(_request, context) {
			try {
				yield resultPart([1])
				await onAbort(context.signal)
			} finally {
				stopped.resolve()
			}
		},
	})
	using trace = observePool(server.driver)
	using client = new QueryClient(server.driver, { poolOptions: { maxSize: 1 } })
	let operation = client
		.retrySession(
			{ signal: tc.signal, idempotent: true, retry: { budget: 3 } },
			async (executor) => {
				let stream = executor.stream('held')
				await stream.next()
				entered.resolve()
				await continueCallback.promise
				callbackFinished.resolve()
				return 'late callback result'
			}
		)
		.catch((error: unknown) => error)
	await abortable(tc.signal, entered.promise)
	let closing = client.close()
	client.destroy()
	let failure = await operation
	await abortable(tc.signal, closing)
	await abortable(tc.signal, stopped.promise)
	continueCallback.resolve()
	await abortable(tc.signal, callbackFinished.promise)

	expect(failure).toBe(client.signal.reason)
	expect(server.executions).toHaveLength(1)
	expect(trace.acquired).toHaveLength(1)
	expect(trace.released).toEqual(trace.acquired)
})
