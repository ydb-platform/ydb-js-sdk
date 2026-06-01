import { expect, test } from 'vitest'
import { type Driver, kRegisterLibrary } from '@ydbjs/core'
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

test('throws when neither driver nor connectionString is provided', () => {
	expect(
		() =>
			// @ts-expect-error — exercising the runtime guard for the union shape.
			new YDBVectorStore(embeddings, {})
	).toThrow(/Either `driver` or a non-empty `connectionString`/)
})

test('treats { driver, connectionString: undefined } as the driver branch', () => {
	// @ts-expect-error — partial union shape that the runtime should handle.
	let store = new YDBVectorStore(embeddings, { driver: stubDriver, connectionString: undefined })

	expect(store).toBeInstanceOf(YDBVectorStore)
})

test('throws YDBVectorStoreConfigError for an unknown search strategy', () => {
	expect(
		() =>
			new YDBVectorStore(embeddings, {
				driver: stubDriver,
				// @ts-expect-error — exercising the runtime guard against TS-bypass.
				strategy: 'BogusStrategy',
			})
	).toThrow(/Unknown search strategy: "BogusStrategy"/)
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

test('every declared strategy is constructable', () => {
	for (let strategy of Object.values(YDBSearchStrategy)) {
		let store = new YDBVectorStore(embeddings, { driver: stubDriver, strategy })
		expect(store).toBeInstanceOf(YDBVectorStore)
	}
})
