import { expect, test, vi } from 'vitest'
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
