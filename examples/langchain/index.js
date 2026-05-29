import { Document } from '@langchain/core/documents'
import { OpenAIEmbeddings } from '@langchain/openai'
import { YDBSearchStrategy, YDBVectorStore } from '@ydbjs/langchain'

let connectionString = process.env.YDB_CONNECTION_STRING || 'grpc://localhost:2136/local'

let embeddings = new OpenAIEmbeddings({
	model: 'text-embedding-3-small',
	apiKey: process.env.OPENAI_API_KEY,
})

// The store owns the Driver when constructed with connectionString.
// `await using` calls store[Symbol.asyncDispose]() on scope exit.
await using store = new YDBVectorStore(embeddings, {
	connectionString,
	table: 'langchain_example',
	dropExistingTable: true,
})

// ── Insert documents ────────────────────────────────────────────────────────

let docs = [
	new Document({
		pageContent: 'YDB is a distributed SQL database',
		metadata: { source: 'docs', lang: 'en' },
	}),
	new Document({
		pageContent: 'LangChain simplifies building LLM applications',
		metadata: { source: 'docs', lang: 'en' },
	}),
	new Document({
		pageContent: 'Vector search finds semantically similar content',
		metadata: { source: 'wiki', lang: 'en' },
	}),
	new Document({
		pageContent: 'YDB поддерживает векторный поиск через KNN UDF',
		metadata: { source: 'docs', lang: 'ru' },
	}),
]

let ids = await store.addDocuments(docs)
console.log('Inserted IDs:', ids)

// ── Similarity search ───────────────────────────────────────────────────────

let results = await store.similaritySearchWithScore('distributed database', 3)
console.log('\nTop matches for "distributed database":')
for (let [doc, score] of results) {
	console.log(`  [${score.toFixed(4)}] ${doc.pageContent}`)
}

// ── Metadata filter ─────────────────────────────────────────────────────────

let enDocs = await store.similaritySearch('database', 10, { source: 'docs', lang: 'en' })
console.log('\nEnglish docs-source results:')
for (let doc of enDocs) {
	console.log(`  ${doc.pageContent}`)
}

// ── Delete ──────────────────────────────────────────────────────────────────

await store.delete({ ids: [ids[2]] })
console.log('\nDeleted one document. Remaining count after search:')

let remaining = await store.similaritySearch('content', 10)
console.log(' ', remaining.length, 'documents')

// ── Search strategies ───────────────────────────────────────────────────────

let distStore = new YDBVectorStore(embeddings, {
	connectionString,
	table: 'langchain_example_dist',
	dropExistingTable: true,
	strategy: YDBSearchStrategy.CosineDistance,
})

await distStore.addDocuments([
	new Document({ pageContent: 'alpha', metadata: {} }),
	new Document({ pageContent: 'beta', metadata: {} }),
])

let distResults = await distStore.similaritySearchWithScore('alpha', 2)
console.log('\nCosineDistance results (lower = closer):')
for (let [doc, score] of distResults) {
	console.log(`  [${score.toFixed(4)}] ${doc.pageContent}`)
}

await distStore.drop()
distStore.close()
