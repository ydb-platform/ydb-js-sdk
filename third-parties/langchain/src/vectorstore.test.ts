import { expect, test, vi } from 'vitest'
import { Float32Vector } from '@ydbjs/value/vector'
import { abortable } from '@ydbjs/abortable'
import { Driver, kRegisterLibrary } from '@ydbjs/core'
import {
	type OperationOptions,
	QueryClient,
	type QueryExecutor,
	type QueryParameters,
} from '@ydbjs/query'
import { RunnableLambda, RunnableSequence } from '@langchain/core/runnables'
import type { EmbeddingsInterface } from '@langchain/core/embeddings'

import { YDBVectorStoreConfigError, YDBVectorStoreError } from './errors.ts'
import { YDBSearchStrategy, YDBVectorStore, type YDBVectorStoreConfig } from './vectorstore.ts'

// SessionPool only stashes `driver` in its constructor — it never calls
// driver methods until a session is acquired. We also need a no-op
// `kRegisterLibrary` since the store calls it during construction.
let stubDriver = { [kRegisterLibrary]() {} } as unknown as Driver
let embeddings: EmbeddingsInterface = {
	embedDocuments: async (docs) => docs.map(() => [0, 0, 0, 0]),
	embedQuery: async () => [0, 0, 0, 0],
}

// ── constructor validation ────────────────────────────────────────────────

test('throws YDBVectorStoreConfigError for an empty connectionString', () => {
	expect(() => new YDBVectorStore(embeddings, { connectionString: '' })).toThrow(
		YDBVectorStoreConfigError
	)
})

test('requires a connection source', () => {
	expect(() => {
		// @ts-expect-error — exercising the runtime guard for the union shape.
		return new YDBVectorStore(embeddings, {})
	}).toThrow(/exactly one of queryClient, driver, or connectionString/)
})

test('treats { driver, connectionString: undefined } as the driver branch', () => {
	// @ts-expect-error — partial union shape that the runtime should handle.
	let store = new YDBVectorStore(embeddings, { driver: stubDriver, connectionString: undefined })

	expect(store).toBeInstanceOf(YDBVectorStore)
})

test.each(['BogusStrategy', 'constructor', '__proto__'])('rejects strategy %s', (strategy) => {
	expect(() => {
		return new YDBVectorStore(embeddings, {
			driver: stubDriver,
			// @ts-expect-error — exercising the runtime guard against TS-bypass.
			strategy,
		})
	}).toThrow(/Unknown search strategy/)
})

test.each([
	['batchSize', 0],
	['batchSize', -1],
	['batchSize', 1.5],
])('throws YDBVectorStoreConfigError for non-positive-integer %s = %s', (field, value) => {
	let make = () => new YDBVectorStore(embeddings, { driver: stubDriver, [field]: value })

	expect(make).toThrow(YDBVectorStoreConfigError)
	expect(make).toThrow(new RegExp(`${field} must be a positive integer`))
})

test.each([
	['indexVectorDimension', 0],
	['indexVectorDimension', -1],
	['indexVectorDimension', 1.5],
	['indexConfigLevels', 0],
	['indexConfigLevels', -1],
	['indexConfigLevels', 1.5],
	['indexConfigClusters', 0],
	['indexConfigClusters', -1],
	['indexConfigClusters', 1.5],
	['indexTreeSearchTopSize', 0],
	['indexTreeSearchTopSize', -1],
	['indexTreeSearchTopSize', 1.5],
])(
	'throws YDBVectorStoreConfigError when indexEnabled with non-positive-integer %s = %s',
	(field, value) => {
		let config = {
			driver: stubDriver,
			indexEnabled: true,
			indexVectorDimension: 1536,
			[field]: value,
		} as unknown as YDBVectorStoreConfig
		let make = () => new YDBVectorStore(embeddings, config)

		expect(make).toThrow(YDBVectorStoreConfigError)
		expect(make).toThrow(new RegExp(`${field} must be a positive integer`))
	}
)

test('YDBVectorStoreConfigError extends YDBVectorStoreError', () => {
	expect(new YDBVectorStoreConfigError('x')).toBeInstanceOf(YDBVectorStoreError)
})

test('accepts a valid index-enabled config', () => {
	let store = new YDBVectorStore(embeddings, {
		driver: stubDriver,
		indexEnabled: true,
		indexVectorDimension: 1536,
		indexConfigLevels: 3,
		indexConfigClusters: 256,
		indexTreeSearchTopSize: 4,
		batchSize: 100,
	})

	expect(store).toBeInstanceOf(YDBVectorStore)
})

test('accepts a minimal config without index', () => {
	let store = new YDBVectorStore(embeddings, { driver: stubDriver })

	expect(store).toBeInstanceOf(YDBVectorStore)
})

// ── static helpers ────────────────────────────────────────────────────────

test('fromExistingTable accepts a config with table name', () => {
	let store = YDBVectorStore.fromExistingTable(embeddings, {
		driver: stubDriver,
		table: 'existing_table',
	})

	expect(store).toBeInstanceOf(YDBVectorStore)
})

test('rejects conflicting connection sources', async () => {
	await using queryClient = new QueryClient(stubDriver)

	expect(() => {
		// @ts-expect-error — JavaScript callers can supply both sources.
		return new YDBVectorStore(embeddings, { queryClient, driver: stubDriver })
	}).toThrow(/exactly one/)
})

test('invalid options fail before the store registers with the driver', () => {
	let register = vi.fn()
	let driver = { [kRegisterLibrary]: register } as unknown as Driver

	expect(() => {
		return new YDBVectorStore(embeddings, { driver, batchSize: 0 })
	}).toThrow(YDBVectorStoreConfigError)
	expect(register).not.toHaveBeenCalled()
})

test('each attempt binds fresh parameters with the same IDs, embeddings and filters', async () => {
	let { client, execute, retrySession } = fakeClient()
	let session = { execute } as unknown as QueryExecutor

	retrySession.mockImplementation(async (_options, callback) => {
		await callback(session)

		return callback(session)
	})

	let vector = [1, 2]
	let filter = { source: 'docs' }
	let embedQuery = vi.fn(async () => {
		return vector
	})
	let embedDocuments = vi.fn(embeddings.embedDocuments)
	await using store = YDBVectorStore.fromExistingTable(
		{ embedDocuments, embedQuery },
		{
			queryClient: client,
			table: 'vectors',
		}
	)

	let ids = await store.addDocuments([{ pageContent: 'document', metadata: {} }])

	execute.mockImplementationOnce(async () => {
		vector[0] = 3
		filter.source = 'changed'

		return { resultSets: [{ rows: [] }] }
	})

	await store.similaritySearch('query', 2, filter)
	await store.delete({ ids })

	let [first, replay, search, searchReplay, deletion, deletionReplay] = execute.mock.calls
	expect(first![1]?.batch).toEqual([expect.objectContaining({ id: ids[0] })])
	expect(replay).toEqual(first)
	expect(replay![1]).not.toBe(first![1])
	expect(search![1]?.filter0).toBe('docs')
	expect(searchReplay).toEqual(search)
	expect(searchReplay![1]).not.toBe(search![1])
	expect(searchReplay![1]?.k).not.toBe(search![1]?.k)
	expect(deletion![1]?.ids).toEqual(ids)
	expect(deletionReplay).toEqual(deletion)
	expect(deletionReplay![1]).not.toBe(deletion![1])
	expect(retrySession.mock.calls[0]![0]).toMatchObject({ signal: expect.any(AbortSignal) })
	expect(retrySession.mock.calls[1]![0]).toMatchObject({ idempotent: true })
	expect(embedQuery).toHaveBeenCalledOnce()
	expect(embedDocuments).toHaveBeenCalledOnce()
})

test('fromDocuments closes its client and driver when embedding fails', async () => {
	using closeDriver = vi.spyOn(Driver.prototype, 'close')
	using closeClient = vi.spyOn(QueryClient.prototype, 'close')
	let error = new Error('embedding failed')
	let embedDocuments = vi.fn().mockRejectedValue(error)

	await expect(
		YDBVectorStore.fromDocuments(
			[{ pageContent: 'one', metadata: {} }],
			{ ...embeddings, embedDocuments },
			{
				connectionString: 'grpc://localhost:2136/local',
				driverOptions: { 'ydb.sdk.enable_discovery': false },
			}
		)
	).rejects.toBe(error)

	expect(closeClient).toHaveBeenCalledOnce()
	expect(closeDriver).toHaveBeenCalledOnce()
})

test('every declared strategy is constructable', () => {
	for (let strategy of Object.values(YDBSearchStrategy)) {
		let store = new YDBVectorStore(embeddings, { driver: stubDriver, strategy })
		expect(store).toBeInstanceOf(YDBVectorStore)
	}
})

function fakeClient(rows: Record<string, unknown>[] = []) {
	let execute = vi.fn(async (_query: string, _parameters?: QueryParameters) => {
		return { resultSets: [{ rows }] }
	})
	let retrySession = vi.fn(
		async (
			_options: OperationOptions,
			callback: (session: QueryExecutor) => Promise<unknown>
		) => {
			return callback({ execute } as unknown as QueryExecutor)
		}
	)
	let close = vi.fn(async () => {})
	let client = { driver: stubDriver, retrySession, close } as unknown as QueryClient
	return { client, execute, retrySession, close }
}

test.each(['addDocuments', 'addVectors'] as const)(
	'%s gives options.ids precedence over document IDs',
	async (method) => {
		let { client, execute } = fakeClient()
		await using store = new YDBVectorStore(embeddings, { queryClient: client })
		let documents = [{ id: 'document-id', pageContent: 'one', metadata: {} }]
		let ids =
			method === 'addDocuments'
				? await store.addDocuments(documents, { ids: ['option-id'] })
				: await store.addVectors([[1, 2]], documents, { ids: ['option-id'] })

		expect(ids).toEqual(['option-id'])
		expect(execute.mock.calls.at(-1)![1]?.batch).toEqual([
			expect.objectContaining({ id: 'option-id' }),
		])
	}
)

test.each([[], ['one', 'two'], [''], [1], 'one'])(
	'rejects invalid ids %j before embedding or schema setup',
	async (ids) => {
		let { client, execute } = fakeClient()
		let embedDocuments = vi.fn(embeddings.embedDocuments)
		await using store = new YDBVectorStore(
			{ ...embeddings, embedDocuments },
			{
				queryClient: client,
				dropExistingTable: true,
			}
		)
		let documents = [{ pageContent: 'one', metadata: {} }]
		let options = { ids: ids as string[] }

		await expect(store.addDocuments(documents, options)).rejects.toThrow(/ids/)
		await expect(store.addVectors([[1, 2]], documents, options)).rejects.toThrow(/ids/)
		expect(embedDocuments).not.toHaveBeenCalled()
		expect(execute).not.toHaveBeenCalled()
	}
)

test.each(['false', 1, null])(
	'rejects non-boolean deleteAll %j before schema setup',
	async (deleteAll) => {
		let { client, execute } = fakeClient()
		await using store = new YDBVectorStore(embeddings, {
			queryClient: client,
			dropExistingTable: true,
		})

		// @ts-expect-error JavaScript callers can pass non-boolean values.
		await expect(store.delete({ deleteAll })).rejects.toThrow(/deleteAll must be a boolean/)
		expect(execute).not.toHaveBeenCalled()
	}
)

test('rejects invalid document and delete IDs before schema setup', async () => {
	let { client, execute } = fakeClient()
	let embedDocuments = vi.fn(embeddings.embedDocuments)
	await using store = new YDBVectorStore(
		{ ...embeddings, embedDocuments },
		{ queryClient: client, dropExistingTable: true }
	)
	await expect(
		store.addDocuments([{ id: '', pageContent: 'one', metadata: {} }])
	).rejects.toThrow(/ids/)
	await expect(store.delete({ ids: [7 as unknown as string], deleteAll: true })).rejects.toThrow(
		/ids/
	)
	expect(embedDocuments).not.toHaveBeenCalled()
	expect(execute).not.toHaveBeenCalled()
})

test('rejects mixed dimensions before schema setup and indexed dimension mismatch before search', async () => {
	let { client, execute } = fakeClient()
	await using store = new YDBVectorStore(embeddings, {
		queryClient: client,
		dropExistingTable: true,
	})
	await expect(
		store.addVectors(
			[[1, 2], [1]],
			[
				{ pageContent: 'one', metadata: {} },
				{ pageContent: 'two', metadata: {} },
			]
		)
	).rejects.toThrow(/dimensions/)

	await using indexed = new YDBVectorStore(embeddings, {
		queryClient: client,
		dropExistingTable: true,
		indexEnabled: true,
		indexVectorDimension: 3,
	})
	await expect(
		indexed.addVectors([[1, 2]], [{ pageContent: 'one', metadata: {} }])
	).rejects.toThrow(/3 dimensions/)
	await expect(indexed.similaritySearchVectorWithScore([1, 2], 1)).rejects.toThrow(/3 dimensions/)
	expect(execute).not.toHaveBeenCalled()
})

test.each([null, Number.NaN, Number.POSITIVE_INFINITY, '0.5'])(
	'rejects invalid score %s without numeric coercion',
	async (score) => {
		let { client } = fakeClient([{ id: 'one', document: 'one', metadata: {}, score }])
		await using store = YDBVectorStore.fromExistingTable(embeddings, {
			queryClient: client,
			table: 'vectors',
		})
		await expect(store.similaritySearchVectorWithScore([1, 2], 1)).rejects.toThrow(
			/invalid vector score/
		)
	}
)

test('zero-result searches skip embedding and schema setup', async () => {
	let { client, execute } = fakeClient()
	let embedQuery = vi.fn(embeddings.embedQuery)
	await using store = new YDBVectorStore(
		{ ...embeddings, embedQuery },
		{ queryClient: client, dropExistingTable: true }
	)
	expect(await store.similaritySearch('one', 0)).toEqual([])
	expect(await store.similaritySearchWithScore('one', 0)).toEqual([])
	expect(await store.similaritySearchVectorWithScore([], 0)).toEqual([])
	expect(embedQuery).not.toHaveBeenCalled()
	expect(execute).not.toHaveBeenCalled()
})

test('embeds and commits one batch before requesting the next batch', async () => {
	let { client, execute, retrySession } = fakeClient()
	let events: string[] = []
	let embedDocuments = vi.fn(async (documents: string[]) => {
		events.push(`embed:${documents.join(',')}`)
		return documents.map(() => {
			return [1, 2]
		})
	})
	execute.mockImplementation(async (_query, parameters) => {
		let batch = parameters?.batch as unknown as { id: string }[]
		events.push(
			`write:${batch
				.map((row) => {
					return row.id
				})
				.join(',')}`
		)
		return { resultSets: [{ rows: [] }] }
	})
	await using store = YDBVectorStore.fromExistingTable(
		{ ...embeddings, embedDocuments },
		{
			queryClient: client,
			table: 'vectors',
			batchSize: 2,
		}
	)
	let ids = await store.addDocuments(
		['a', 'b', 'c'].map((id) => {
			return { id, pageContent: id, metadata: {} }
		})
	)

	expect(ids).toEqual(['a', 'b', 'c'])
	expect(events).toEqual(['embed:a,b', 'write:a,b', 'embed:c', 'write:c'])
	expect(retrySession.mock.calls[0]![0].signal).toBe(retrySession.mock.calls[1]![0].signal)
})

test('close drains an active operation without closing a borrowed client', async () => {
	let { client, execute, close } = fakeClient()
	let embedding = Promise.withResolvers<number[][]>()
	let embedDocuments = vi.fn(() => {
		return embedding.promise
	})
	let store = new YDBVectorStore({ ...embeddings, embedDocuments }, { queryClient: client })
	let writing = store.addDocuments([{ id: 'one', pageContent: 'one', metadata: {} }])
	let closed = false
	let closing = store.close().then(() => {
		closed = true
		return undefined
	})
	await Promise.resolve()
	expect(closed).toBe(false)
	await expect(store.addDocuments([])).rejects.toThrow(/closed/)
	embedding.resolve([[1, 2]])
	await writing
	await closing
	expect(execute).toHaveBeenCalledTimes(2)
	expect(close).not.toHaveBeenCalled()
})

test('abort stops waiting for embeddings and close does not wait for the provider', async () => {
	let { client, execute } = fakeClient()
	let embedding = Promise.withResolvers<number[][]>()
	let controller = new AbortController()
	let error = new Error('cancelled embedding')
	let started = Promise.withResolvers<void>()
	let store = new YDBVectorStore(
		{
			...embeddings,
			embedDocuments: () => {
				started.resolve()
				return embedding.promise
			},
		},
		{ queryClient: client }
	)
	let writing = store.addDocuments([{ pageContent: 'one', metadata: {} }], {
		signal: controller.signal,
	})
	await started.promise
	controller.abort(error)
	await expect(writing).rejects.toBe(error)
	await store.close()
	embedding.resolve([[1, 2]])
	await embedding.promise
	expect(execute).not.toHaveBeenCalled()
})

test('retriever invocations propagate cancellation and isolate concurrent calls', async () => {
	let { client, execute } = fakeClient()
	let first = Promise.withResolvers<number[]>()
	let second = Promise.withResolvers<number[]>()
	let started = Promise.withResolvers<void>()
	let embedQuery = vi.fn((query: string) => {
		if (embedQuery.mock.calls.length === 2) {
			started.resolve()
		}
		return query === 'first' ? first.promise : second.promise
	})
	await using store = YDBVectorStore.fromExistingTable(
		{ ...embeddings, embedQuery },
		{ queryClient: client, table: 'vectors' }
	)
	let retriever = store.asRetriever({ k: 1 })
	let controller = new AbortController()
	let cancelled = retriever.invoke('first', { signal: controller.signal })
	let completed = retriever.invoke('second')
	await started.promise
	let reason = new Error('cancel first retriever')
	controller.abort(reason)
	await expect(cancelled).rejects.toBe(reason)
	second.resolve([1, 2])
	expect(await completed).toEqual([])
	first.resolve([3, 4])
	await first.promise
	expect(execute).toHaveBeenCalledOnce()
})

test('retry settings apply only to the current operation', async () => {
	let { client, retrySession } = fakeClient()
	await using store = YDBVectorStore.fromExistingTable(embeddings, {
		queryClient: client,
		table: 'vectors',
	})

	await store.similaritySearchVectorWithScore([1, 2], 1, undefined, {
		retry: { budget: 3 },
	})
	await store.similaritySearchVectorWithScore([1, 2], 1)

	expect(retrySession.mock.calls[0]![0].retry).toEqual({ budget: 3 })
	expect(retrySession.mock.calls[1]![0].retry).toBeUndefined()
})

test('non-finite search coordinates fail before schema setup', async () => {
	let { client, execute } = fakeClient()
	await using store = new YDBVectorStore(embeddings, {
		queryClient: client,
		dropExistingTable: true,
	})
	await expect(
		store.addVectors([[1, Number.NaN]], [{ pageContent: 'one', metadata: {} }])
	).rejects.toThrow(/coordinate 1 must be finite/)
	await expect(store.similaritySearchVectorWithScore([1, Infinity], 1)).rejects.toThrow(
		/coordinate 1 must be finite/
	)
	expect(execute).not.toHaveBeenCalled()
})

test('write batches share the caller budget and preserve query errors', async () => {
	let { client, retrySession } = fakeClient()
	await using store = new YDBVectorStore(embeddings, { queryClient: client, batchSize: 1 })
	await store.addDocuments([
		{ pageContent: 'one', metadata: {} },
		{ pageContent: 'two', metadata: {} },
	])
	let signals = retrySession.mock.calls.map(([options]) => {
		return options.signal
	})
	expect(signals).toHaveLength(3)
	expect(signals[1]).toBe(signals[2])
	expect(signals[0]).not.toBe(signals[1])
	let failure = new Error('original query failure')
	retrySession.mockRejectedValueOnce(failure)
	await expect(store.similaritySearchVectorWithScore([1, 2], 1)).rejects.toBe(failure)
})

test('cancelling one caller preserves shared initialization for another caller', async () => {
	let { client, execute, retrySession } = fakeClient()
	let started = Promise.withResolvers<AbortSignal>()
	let initialized = Promise.withResolvers<void>()
	let firstAttempt = true

	retrySession.mockImplementation(async (options, callback) => {
		if (firstAttempt) {
			firstAttempt = false
			started.resolve(options.signal!)
			await abortable(options.signal, initialized.promise)
		}

		return callback({ execute } as unknown as QueryExecutor)
	})

	await using store = new YDBVectorStore(embeddings, { queryClient: client })
	let firstController = new AbortController()
	let first = store.addVectors([[1, 2]], [{ id: 'first', pageContent: 'first', metadata: {} }], {
		signal: firstController.signal,
	})
	let second = store.addVectors([[1, 2]], [{ id: 'second', pageContent: 'second', metadata: {} }])
	let initializationSignal = await started.promise
	let reason = new Error('first caller cancelled')
	firstController.abort(reason)

	await expect(first).rejects.toBe(reason)
	expect(initializationSignal.aborted).toBe(false)
	initialized.resolve()
	expect(await second).toEqual(['second'])
	expect(execute).toHaveBeenCalledTimes(2)
	expect(execute.mock.calls[1]![1]?.batch).toEqual([expect.objectContaining({ id: 'second' })])
})

test('cancelling all initialization waiters stops setup and prevents later writes', async () => {
	let { client, execute, retrySession } = fakeClient()
	let started = Promise.withResolvers<AbortSignal>()
	let initialized = Promise.withResolvers<void>()

	retrySession.mockImplementation(async (options, callback) => {
		started.resolve(options.signal!)
		await abortable(options.signal, initialized.promise)
		return callback({ execute } as unknown as QueryExecutor)
	})

	let store = new YDBVectorStore(embeddings, { queryClient: client })
	let firstController = new AbortController()
	let secondController = new AbortController()
	let documents = [{ pageContent: 'document', metadata: {} }]
	let first = store.addVectors([[1, 2]], documents, { signal: firstController.signal })
	let second = store.addVectors([[1, 2]], documents, { signal: secondController.signal })
	let initializationSignal = await started.promise
	let firstReason = new Error('first caller cancelled')
	let secondReason = new Error('second caller cancelled')
	firstController.abort(firstReason)

	await expect(first).rejects.toBe(firstReason)
	expect(initializationSignal.aborted).toBe(false)
	secondController.abort(secondReason)
	await expect(second).rejects.toBe(secondReason)
	expect(initializationSignal.aborted).toBe(true)
	await store.close()
	initialized.resolve()
	await initialized.promise
	expect(execute).not.toHaveBeenCalled()
})

test('a cancelled initialization cannot clear a replacement initialization', async () => {
	let { client, execute, retrySession } = fakeClient()
	let firstStarted = Promise.withResolvers<void>()
	let secondStarted = Promise.withResolvers<void>()
	let firstCleanup = Promise.withResolvers<void>()
	let secondInitialized = Promise.withResolvers<void>()
	let neverInitialized = Promise.withResolvers<void>()
	let attempts = 0

	retrySession.mockImplementation(async (options, callback) => {
		attempts++

		if (attempts === 1) {
			firstStarted.resolve()

			try {
				await abortable(options.signal, neverInitialized.promise)
			} finally {
				await firstCleanup.promise
			}
		} else if (attempts === 2) {
			secondStarted.resolve()
			await secondInitialized.promise
		}

		return callback({ execute } as unknown as QueryExecutor)
	})

	await using store = new YDBVectorStore(embeddings, { queryClient: client })
	let controller = new AbortController()
	let documents = [{ pageContent: 'document', metadata: {} }]
	let first = store.addVectors([[1, 2]], documents, { signal: controller.signal })
	await firstStarted.promise
	let reason = new Error('cancel old initialization')
	controller.abort(reason)
	await expect(first).rejects.toBe(reason)

	let second = store.addVectors([[1, 2]], documents)
	await secondStarted.promise
	firstCleanup.resolve()
	await expect(retrySession.mock.results[0]!.value).rejects.toBe(reason)
	let third = store.addVectors([[1, 2]], documents)
	await Promise.resolve()
	expect(retrySession).toHaveBeenCalledTimes(2)
	secondInitialized.resolve()
	await Promise.all([second, third])
})

test('a cancelled DROP is not repeated by a later caller', async () => {
	let { client, execute, retrySession } = fakeClient()
	let started = Promise.withResolvers<void>()
	let neverConfirmed = Promise.withResolvers<void>()

	retrySession.mockImplementation(async (options, callback) => {
		await callback({ execute } as unknown as QueryExecutor)
		started.resolve()
		return abortable(options.signal, neverConfirmed.promise)
	})

	await using store = new YDBVectorStore(embeddings, {
		queryClient: client,
		dropExistingTable: true,
	})
	let controller = new AbortController()
	let documents = [{ pageContent: 'document', metadata: {} }]
	let first = store.addVectors([[1, 2]], documents, { signal: controller.signal })
	await started.promise
	let reason = new Error('DROP outcome unknown')
	controller.abort(reason)
	await expect(first).rejects.toBe(reason)
	await expect(store.addVectors([[1, 2]], documents)).rejects.toBe(reason)
	expect(execute).toHaveBeenCalledOnce()
	expect(execute.mock.calls[0]![0]).toMatch(/^DROP TABLE/)
})

test('precomputed vectors accept typed-array views with their visible coordinates', async () => {
	let { client, execute } = fakeClient()
	await using store = YDBVectorStore.fromExistingTable(embeddings, {
		queryClient: client,
		table: 'vectors',
	})
	let backing = new Float32Array([99, 1.5, 2.5, 99])
	let vector = backing.subarray(1, 3)
	await store.addVectors([vector], [{ id: 'one', pageContent: 'one', metadata: {} }])
	await store.similaritySearchVectorWithScore(vector, 1)

	let batch = execute.mock.calls[0]![1]?.batch as unknown as { embedding: Float32Vector }[]
	let query = execute.mock.calls[1]![1]?.vector as Float32Vector
	expect(batch[0]!.embedding).toBeInstanceOf(Float32Vector)
	expect(batch[0]!.embedding.toTypedArray()).toEqual(new Float32Array([1.5, 2.5]))
	expect(query.toTypedArray()).toEqual(new Float32Array([1.5, 2.5]))
})

test('malformed JavaScript vectors fail before schema setup', async () => {
	let { client, execute } = fakeClient()
	await using store = new YDBVectorStore(embeddings, {
		queryClient: client,
		dropExistingTable: true,
	})
	let vector = null as unknown as ArrayLike<number>
	await expect(
		store.addVectors([vector], [{ pageContent: 'one', metadata: {} }])
	).rejects.toThrow(/array-like numeric length/)
	await expect(store.similaritySearchVectorWithScore(vector, 1)).rejects.toThrow(
		/array-like numeric length/
	)
	expect(execute).not.toHaveBeenCalled()
})

test('a closed query client rejects operations before embedding', async () => {
	await using client = new QueryClient(stubDriver)
	let embedDocuments = vi.fn(embeddings.embedDocuments)
	let embedQuery = vi.fn(embeddings.embedQuery)
	await using store = new YDBVectorStore({ embedDocuments, embedQuery }, { queryClient: client })
	await client.close()

	await expect(store.addDocuments([{ pageContent: 'one', metadata: {} }])).rejects.toThrow(
		/Query client is closed/
	)
	await expect(store.similaritySearch('one', 1)).rejects.toThrow(/Query client is closed/)
	expect(embedDocuments).not.toHaveBeenCalled()
	expect(embedQuery).not.toHaveBeenCalled()
})

test('destroying the query client cancels pending embeddings without later writes', async () => {
	using client = new QueryClient(stubDriver)
	using retrySession = vi.spyOn(client, 'retrySession')
	let embedding = Promise.withResolvers<number[][]>()
	let started = Promise.withResolvers<void>()
	let store = new YDBVectorStore(
		{
			...embeddings,
			embedDocuments: () => {
				started.resolve()
				return embedding.promise
			},
		},
		{ queryClient: client }
	)
	let writing = store.addDocuments([{ pageContent: 'one', metadata: {} }])
	await started.promise
	client.destroy()

	await expect(writing).rejects.toBe(client.signal.reason)
	await store.close()
	embedding.resolve([[1, 2]])
	await embedding.promise
	expect(retrySession).not.toHaveBeenCalled()
})

test.each(['direct', 'sequence'] as const)(
	'%s retriever forwards the caller signal through embedding',
	async (mode) => {
		let { client, execute } = fakeClient()
		let started = Promise.withResolvers<void>()
		let embedding = Promise.withResolvers<number[]>()
		await using store = YDBVectorStore.fromExistingTable(
			{
				...embeddings,
				embedQuery: () => {
					started.resolve()
					return embedding.promise
				},
			},
			{ queryClient: client, table: 'vectors' }
		)
		let retriever = store.asRetriever()
		let identity = RunnableLambda.from((input: string) => {
			return input
		})
		let runnable = mode === 'direct' ? retriever : RunnableSequence.from([identity, retriever])
		let controller = new AbortController()

		let search = runnable.invoke('query', { signal: controller.signal })
		await started.promise

		let reason = new Error('Cancelled retrieval')
		controller.abort(reason)

		await expect(search).rejects.toBe(reason)
		embedding.resolve([1, 2])
		await embedding.promise
		expect(execute).not.toHaveBeenCalled()
	}
)

test('empty embeddings fail before schema setup', async () => {
	let { client, execute } = fakeClient()
	await using store = new YDBVectorStore(embeddings, {
		queryClient: client,
		dropExistingTable: true,
	})
	await expect(store.addVectors([[]], [{ pageContent: 'one', metadata: {} }])).rejects.toThrow(
		/dimension must be a positive integer/
	)
	await expect(store.similaritySearchVectorWithScore([], 1)).rejects.toThrow(
		/dimension must be a positive integer/
	)
	expect(execute).not.toHaveBeenCalled()
})
