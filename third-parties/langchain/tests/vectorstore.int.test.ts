import { afterAll, beforeAll, expect, inject, test } from 'vitest'
import { Driver } from '@ydbjs/core'
import { Document } from '@langchain/core/documents'
import { FakeEmbeddings, SyntheticEmbeddings } from '@langchain/core/utils/testing'
import { YDBSearchStrategy, YDBVectorStore } from '../src/index.ts'

let CONNECTION_STRING = inject('connectionString')
let TABLE = `langchain_int_test_${Date.now()}`
let embeddings = new FakeEmbeddings()

let driver: Driver

beforeAll(async () => {
	driver = new Driver(CONNECTION_STRING)
	await driver.ready()
})

afterAll(async () => {
	try {
		let store = YDBVectorStore.fromExistingTable(embeddings, { driver, table: TABLE })
		await store.drop()
	} catch {
		// table may not exist if an earlier test already dropped it
	}
	driver.close()
})

function makeStore(overrides: Record<string, unknown> = {}) {
	return new YDBVectorStore(embeddings, { driver, table: TABLE, ...overrides })
}

// ── basic CRUD ───────────────────────────────────────────────────────

test('fromTexts creates store, inserts, and searches', async () => {
	let store = await YDBVectorStore.fromTexts(
		['cat sat on mat', 'dog ran in park', 'fish swam in sea'],
		[{ animal: 'cat' }, { animal: 'dog' }, { animal: 'fish' }],
		embeddings,
		{ driver, table: TABLE, dropExistingTable: true }
	)

	let results = await store.similaritySearch('cat', 2)
	expect(results.length).toBe(2)
	expect(results[0].pageContent).toBeDefined()
})

test('fromDocuments inserts and retrieves document content', async () => {
	let docs = [
		new Document({ pageContent: 'doc A', metadata: { n: 1 } }),
		new Document({ pageContent: 'doc B', metadata: { n: 2 } }),
	]
	let store = await YDBVectorStore.fromDocuments(docs, embeddings, {
		driver,
		table: TABLE,
		dropExistingTable: true,
	})

	let results = await store.similaritySearch('anything', 2)
	expect(results).toHaveLength(2)
	let contents = results.map((r) => r.pageContent)
	expect(contents).toContain('doc A')
	expect(contents).toContain('doc B')
})

test('addDocuments returns IDs and results carry score and metadata', async () => {
	let store = makeStore({ dropExistingTable: true })

	let docs = [
		new Document({
			pageContent: 'LangChain is a framework for LLM apps',
			metadata: { source: 'docs', lang: 'en' },
		}),
		new Document({
			pageContent: 'YDB is a distributed database',
			metadata: { source: 'docs', lang: 'en' },
		}),
		new Document({
			pageContent: 'TypeScript is a typed superset of JavaScript',
			metadata: { source: 'wiki', lang: 'en' },
		}),
	]

	let ids = await store.addDocuments(docs)
	expect(ids).toHaveLength(3)

	let results = await store.similaritySearchWithScore('database', 2)
	expect(results).toHaveLength(2)

	let [topDoc, topScore] = results[0]
	expect(topDoc.pageContent).toBeDefined()
	expect(typeof topScore).toBe('number')
	expect(topDoc.metadata).toHaveProperty('source')
	expect(topDoc.id).toBeDefined()
})

test('explicit document ID is preserved', async () => {
	let store = makeStore({ dropExistingTable: true })

	let ids = await store.addDocuments([
		new Document({ pageContent: 'with explicit id', metadata: {}, id: 'my-custom-id' }),
		new Document({ pageContent: 'without explicit id', metadata: {} }),
	])

	expect(ids[0]).toBe('my-custom-id')
	expect(ids[1]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)

	let results = await store.similaritySearch('anything', 10)
	let result = results.find((r) => r.id === 'my-custom-id')
	expect(result).toBeDefined()
	expect(result!.pageContent).toBe('with explicit id')
})

test('UPSERT replaces existing document on same ID', async () => {
	let store = makeStore({ dropExistingTable: true })

	await store.addDocuments([
		new Document({ pageContent: 'original content', metadata: {}, id: 'upsert-id' }),
	])
	await store.addDocuments([
		new Document({ pageContent: 'updated content', metadata: {}, id: 'upsert-id' }),
	])

	let results = await store.similaritySearch('anything', 10)
	expect(results).toHaveLength(1)
	expect(results[0].pageContent).toBe('updated content')
})

test('splits large batch insert into chunks of 32', async () => {
	let store = makeStore({ dropExistingTable: true })

	let docs = Array.from(
		{ length: 35 },
		(_, i) => new Document({ pageContent: `document ${i}`, metadata: { i } })
	)

	let ids = await store.addDocuments(docs)
	expect(ids).toHaveLength(35)

	let results = await store.similaritySearch('document', 35)
	expect(results).toHaveLength(35)
})

test('searches by raw embedding vector', async () => {
	let store = makeStore({ dropExistingTable: true })

	await store.addDocuments([
		new Document({ pageContent: 'alpha', metadata: {} }),
		new Document({ pageContent: 'beta', metadata: {} }),
	])

	let queryVector = [0.1, 0.2, 0.3, 0.4]
	let results = await store.similaritySearchVectorWithScore(queryVector, 2)
	expect(results).toHaveLength(2)
	expect(results[0][0]).toBeInstanceOf(Document)
	expect(typeof results[0][1]).toBe('number')
})

// ── metadata filter ───────────────────────────────────────────────────

test('metadata filter returns only matching documents', async () => {
	let store = makeStore({ dropExistingTable: true })

	await store.addDocuments([
		new Document({ pageContent: 'wiki 1', metadata: { source: 'wiki' } }),
		new Document({ pageContent: 'wiki 2', metadata: { source: 'wiki' } }),
		new Document({ pageContent: 'wiki 3', metadata: { source: 'wiki' } }),
		new Document({ pageContent: 'docs 1', metadata: { source: 'docs' } }),
		new Document({ pageContent: 'docs 2', metadata: { source: 'docs' } }),
	])

	let wikiResults = await store.similaritySearch('anything', 10, { source: 'wiki' })
	expect(wikiResults).toHaveLength(3)
	expect(wikiResults.every((r) => r.metadata.source === 'wiki')).toBe(true)

	let docsResults = await store.similaritySearch('anything', 10, { source: 'docs' })
	expect(docsResults).toHaveLength(2)
	expect(docsResults.every((r) => r.metadata.source === 'docs')).toBe(true)
})

test('multi-key metadata filter narrows results to all matching keys', async () => {
	let store = makeStore({ dropExistingTable: true })

	await store.addDocuments([
		new Document({ pageContent: 'wiki en', metadata: { source: 'wiki', lang: 'en' } }),
		new Document({ pageContent: 'wiki fr', metadata: { source: 'wiki', lang: 'fr' } }),
		new Document({ pageContent: 'docs en', metadata: { source: 'docs', lang: 'en' } }),
	])

	let results = await store.similaritySearch('anything', 10, { source: 'wiki', lang: 'en' })
	expect(results).toHaveLength(1)
	expect(results[0].pageContent).toBe('wiki en')
})

test('metadata filter with no matches returns empty array', async () => {
	let store = makeStore({ dropExistingTable: true })

	await store.addDocuments([
		new Document({ pageContent: 'some doc', metadata: { source: 'wiki' } }),
	])

	let results = await store.similaritySearch('anything', 10, { source: 'nonexistent' })
	expect(results).toHaveLength(0)
})

// ── delete ────────────────────────────────────────────────────────────

test('delete by IDs removes specific documents', async () => {
	let store = makeStore({ dropExistingTable: true })

	let ids = await store.addDocuments([
		new Document({ pageContent: 'keep me', metadata: {} }),
		new Document({ pageContent: 'delete me', metadata: {} }),
		new Document({ pageContent: 'keep me too', metadata: {} }),
	])

	await store.delete({ ids: [ids[1]] })

	let results = await store.similaritySearch('anything', 10)
	expect(results).toHaveLength(2)

	let contents = results.map((r) => r.pageContent)
	expect(contents).not.toContain('delete me')
	expect(contents).toContain('keep me')
	expect(contents).toContain('keep me too')
})

test('delete all clears the table', async () => {
	let store = makeStore({ dropExistingTable: true })

	await store.addDocuments([
		new Document({ pageContent: 'one', metadata: {} }),
		new Document({ pageContent: 'two', metadata: {} }),
	])

	await store.delete({ deleteAll: true })

	let results = await store.similaritySearch('anything', 10)
	expect(results).toHaveLength(0)
})

// ── metadata round-trip ───────────────────────────────────────────────

test('metadata types survive JSON round-trip', async () => {
	let store = makeStore({ dropExistingTable: true })

	await store.addDocuments([
		new Document({
			pageContent: 'round-trip',
			metadata: { str: 'hello', num: 42, flag: true, nested: { x: 1 } },
		}),
	])

	let results = await store.similaritySearch('anything', 1)
	expect(results).toHaveLength(1)
	expect(results[0].metadata).toEqual({ str: 'hello', num: 42, flag: true, nested: { x: 1 } })
})

// ── auxiliary methods ─────────────────────────────────────────────────

test('fromExistingTable connects without CREATE TABLE', async () => {
	let store1 = makeStore({ dropExistingTable: true })
	await store1.addDocuments([
		new Document({ pageContent: 'persisted', metadata: { key: 'val' } }),
	])

	let store2 = YDBVectorStore.fromExistingTable(embeddings, { driver, table: TABLE })
	let results = await store2.similaritySearch('persisted', 1)
	expect(results).toHaveLength(1)
	expect(results[0].pageContent).toBe('persisted')
	expect(results[0].metadata).toEqual({ key: 'val' })
})

test('custom column map stores and retrieves documents', async () => {
	let customTable = `${TABLE}_custom`
	let store = new YDBVectorStore(embeddings, {
		driver,
		table: customTable,
		dropExistingTable: true,
		columnMap: {
			id: 'doc_id',
			document: 'doc_text',
			embedding: 'doc_vec',
			metadata: 'doc_meta',
		},
	})

	await store.addDocuments([new Document({ pageContent: 'custom columns', metadata: { x: 1 } })])

	let results = await store.similaritySearch('custom', 1)
	expect(results).toHaveLength(1)
	expect(results[0].pageContent).toBe('custom columns')
	expect(results[0].metadata).toEqual({ x: 1 })

	await store.drop()
})

test('drop removes the table', async () => {
	let tmpTable = `${TABLE}_drop`
	let store = new YDBVectorStore(embeddings, { driver, table: tmpTable })

	await store.addDocuments([new Document({ pageContent: 'bye', metadata: {} })])
	await store.drop()

	let store2 = new YDBVectorStore(embeddings, { driver, table: tmpTable })
	let ids = await store2.addDocuments([
		new Document({ pageContent: 'hello again', metadata: {} }),
	])
	expect(ids).toHaveLength(1)

	await store2.drop()
})

// ── search strategies ─────────────────────────────────────────────────

test('CosineSimilarity returns highest score first (DESC)', async () => {
	// SyntheticEmbeddings produces content-based vectors, so semantically
	// similar texts get closer vectors — unlike FakeEmbeddings which is fixed.
	let synth = new SyntheticEmbeddings({ vectorSize: 4 })
	let store = new YDBVectorStore(synth, {
		driver,
		table: TABLE,
		dropExistingTable: true,
		strategy: YDBSearchStrategy.CosineSimilarity,
	})

	await store.addDocuments([
		new Document({ pageContent: 'cat', metadata: {} }),
		new Document({ pageContent: 'xyz', metadata: {} }),
	])

	let results = await store.similaritySearchWithScore('cat', 2)
	expect(results).toHaveLength(2)
	// Similarity: higher = better → descending
	expect(results[0][1]).toBeGreaterThanOrEqual(results[1][1])
	expect(results[0][0].pageContent).toBe('cat')
})

test('CosineDistance returns lowest score first (ASC)', async () => {
	let synth = new SyntheticEmbeddings({ vectorSize: 4 })
	let store = new YDBVectorStore(synth, {
		driver,
		table: TABLE,
		dropExistingTable: true,
		strategy: YDBSearchStrategy.CosineDistance,
	})

	await store.addDocuments([
		new Document({ pageContent: 'cat', metadata: {} }),
		new Document({ pageContent: 'xyz', metadata: {} }),
	])

	let results = await store.similaritySearchWithScore('cat', 2)
	expect(results).toHaveLength(2)
	// Distance: lower = better → ascending
	expect(results[0][1]).toBeLessThanOrEqual(results[1][1])
	expect(results[0][0].pageContent).toBe('cat')
})

// ── connectionString mode ─────────────────────────────────────────────

test('connectionString mode creates driver internally and close() releases it', async () => {
	let connTable = `${TABLE}_connstr`
	let store = new YDBVectorStore(embeddings, {
		connectionString: CONNECTION_STRING,
		table: connTable,
	})

	let ids = await store.addDocuments([
		new Document({ pageContent: 'via connection string', metadata: {} }),
	])
	expect(ids).toHaveLength(1)

	let results = await store.similaritySearch('anything', 1)
	expect(results[0].pageContent).toBe('via connection string')

	await store.drop()
	await store.close()
})

// ── vector index ──────────────────────────────────────────────────────

test('createVectorIndex builds index and search uses it', async () => {
	let indexTable = `${TABLE}_index`
	let store = new YDBVectorStore(embeddings, {
		driver,
		table: indexTable,
		dropExistingTable: true,
		indexEnabled: true,
		indexName: 'test_vec_idx',
		indexVectorDimension: 4,
	})

	await store.addDocuments([
		new Document({ pageContent: 'indexed alpha', metadata: {} }),
		new Document({ pageContent: 'indexed beta', metadata: {} }),
		new Document({ pageContent: 'indexed gamma', metadata: {} }),
	])

	await store.createVectorIndex()

	let results = await store.similaritySearch('indexed', 3)
	expect(results).toHaveLength(3)
	expect(results[0].pageContent).toBeDefined()

	await store.drop()
})

test('createVectorIndex throws when indexEnabled is false', async () => {
	let store = makeStore({ indexEnabled: false })
	await expect(store.createVectorIndex()).rejects.toThrow('indexEnabled is false')
})

test('search with filter and indexEnabled throws', async () => {
	let store = makeStore({
		dropExistingTable: true,
		indexEnabled: true,
		indexVectorDimension: 4,
	})

	await store.addDocuments([new Document({ pageContent: 'test', metadata: { k: 'v' } })])

	await expect(
		store.similaritySearchVectorWithScore([0.1, 0.2, 0.3, 0.4], 1, { k: 'v' })
	).rejects.toThrow('Cannot use metadata filter with vector index enabled')

	await store.drop()
})

// ── concurrency, lifecycle, escaping ──────────────────────────────────

test('serializes concurrent first writes through a single CREATE TABLE', async () => {
	let store = makeStore({ dropExistingTable: true })

	// Five parallel adds — without memoised init they race on CREATE TABLE
	// and (with dropExistingTable) on DROP, risking lost rows.
	await Promise.all(
		Array.from({ length: 5 }, (_, i) =>
			store.addDocuments([new Document({ pageContent: `parallel ${i}`, metadata: { i } })])
		)
	)

	let results = await store.similaritySearch('parallel', 10)
	expect(results).toHaveLength(5)
})

test('recreates the table after drop without re-dropping new data', async () => {
	let store = makeStore({ dropExistingTable: true })

	await store.addDocuments([new Document({ pageContent: 'first', metadata: {} })])
	await store.drop()
	await store.addDocuments([new Document({ pageContent: 'second', metadata: {} })])

	let results = await store.similaritySearch('anything', 10)
	expect(results).toHaveLength(1)
	expect(results[0].pageContent).toBe('second')
})

test('close releases the session pool and refuses further ops', async () => {
	let tmpTable = `${TABLE}_close`
	let store = new YDBVectorStore(embeddings, {
		connectionString: CONNECTION_STRING,
		table: tmpTable,
	})

	await store.addDocuments([new Document({ pageContent: 'pre-close', metadata: {} })])
	await store.close()

	await expect(
		store.addDocuments([new Document({ pageContent: 'post-close', metadata: {} })])
	).rejects.toThrow(/closed|pool/i)
})

test('filter value containing a single quote round-trips correctly', async () => {
	let store = makeStore({ dropExistingTable: true })

	await store.addDocuments([
		new Document({ pageContent: 'tricky', metadata: { name: "O'Reilly" } }),
		new Document({ pageContent: 'plain', metadata: { name: 'Smith' } }),
	])

	let results = await store.similaritySearch('anything', 10, { name: "O'Reilly" })
	expect(results).toHaveLength(1)
	expect(results[0].metadata.name).toBe("O'Reilly")
})

test('construction throws when indexEnabled is true and indexVectorDimension is missing', () => {
	expect(() => makeStore({ indexEnabled: true })).toThrow(
		/indexVectorDimension must be a positive/
	)
})

// ── retriever ─────────────────────────────────────────────────────────

test('asRetriever().invoke() returns Document instances', async () => {
	let store = makeStore({ dropExistingTable: true })

	await store.addDocuments([
		new Document({ pageContent: 'cats like milk', metadata: { kind: 'animal' } }),
		new Document({ pageContent: 'dogs chase balls', metadata: { kind: 'animal' } }),
		new Document({ pageContent: 'compilers parse tokens', metadata: { kind: 'tech' } }),
	])

	let retriever = store.asRetriever()
	let results = await retriever.invoke('cat animal')

	expect(results.length).toBeGreaterThan(0)
	expect(results[0]).toBeInstanceOf(Document)
	expect(results[0].pageContent).toBeDefined()
})

test('asRetriever(k) limits the number of returned documents', async () => {
	let store = makeStore({ dropExistingTable: true })

	await store.addDocuments(
		Array.from(
			{ length: 5 },
			(_, i) => new Document({ pageContent: `document ${i}`, metadata: { i } })
		)
	)

	let retriever = store.asRetriever(2)
	let results = await retriever.invoke('document')

	expect(results).toHaveLength(2)
})

test('asRetriever with filter returns only matching documents', async () => {
	let store = makeStore({ dropExistingTable: true })

	await store.addDocuments([
		new Document({ pageContent: 'wiki article one', metadata: { source: 'wiki' } }),
		new Document({ pageContent: 'wiki article two', metadata: { source: 'wiki' } }),
		new Document({ pageContent: 'api reference', metadata: { source: 'api' } }),
	])

	let retriever = store.asRetriever({ filter: { source: 'wiki' } })
	let results = await retriever.invoke('anything')

	expect(results).toHaveLength(2)
	expect(results.every((r) => r.metadata.source === 'wiki')).toBe(true)
})

test('asRetriever with explicit searchType similarity returns k Document instances', async () => {
	let store = makeStore({ dropExistingTable: true })

	await store.addDocuments([
		new Document({ pageContent: 'alpha', metadata: {} }),
		new Document({ pageContent: 'beta', metadata: {} }),
		new Document({ pageContent: 'gamma', metadata: {} }),
	])

	let retriever = store.asRetriever({ searchType: 'similarity', k: 2 })
	let results = await retriever.invoke('alpha')

	expect(results).toHaveLength(2)
	expect(results[0]).toBeInstanceOf(Document)
})
