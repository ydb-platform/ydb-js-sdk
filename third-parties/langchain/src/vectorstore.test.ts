import { expect, test, vi } from 'vitest'
import { Float32Vector } from '@ydbjs/value/vector'
import { Driver, kRegisterLibrary } from '@ydbjs/core'
import {
	type OperationOptions,
	QueryClient,
	type QueryExecutor,
	type QueryParameters,
} from '@ydbjs/query'
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
	let execute = vi.fn(async (_text: string, _params?: QueryParameters) => {
		return { resultSets: [] }
	})
	let session = { execute } as unknown as QueryExecutor

	type Run = (executor: QueryExecutor) => Promise<unknown>
	let retrySession = vi.fn(async (options: OperationOptions | Run, callback?: Run) => {
		let run = typeof options === 'function' ? options : callback!
		await run(session)

		return run(session)
	})

	let queryClient = { driver: stubDriver, retrySession } as unknown as QueryClient
	let vector = [1, 2]
	let filter = { source: 'docs' }
	let embedQuery = vi.fn(async () => {
		return vector
	})
	let embedDocuments = vi.fn(embeddings.embedDocuments)
	let store = YDBVectorStore.fromExistingTable(
		{ embedDocuments, embedQuery },
		{
			queryClient,
			table: 'vectors',
		}
	)

	let ids = await store.addDocuments([{ pageContent: 'document', metadata: {} }])

	execute.mockImplementationOnce(async () => {
		vector[0] = 3
		filter.source = 'changed'

		return { resultSets: [] }
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
	expect(retrySession.mock.calls[0]![0]).toBeTypeOf('function')
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
	type Run = (session: QueryExecutor) => Promise<unknown>
	let retrySession = vi.fn(async (options: OperationOptions | Run, callback?: Run) => {
		let run = typeof options === 'function' ? options : callback!
		return run({ execute } as unknown as QueryExecutor)
	})
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
	let { client, execute } = fakeClient()
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
