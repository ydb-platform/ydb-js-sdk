import { Driver, type DriverOptions, kRegisterLibrary } from '@ydbjs/core'
import {
	type Fragment,
	type QueryClient,
	type UnsafeString,
	query as createQueryClient,
	fragment,
	identifier,
	join,
	unsafe,
} from '@ydbjs/query'
import { Uint64 } from '@ydbjs/value/primitive'
import type { EmbeddingsInterface } from '@langchain/core/embeddings'
import { VectorStore } from '@langchain/core/vectorstores'
import { Document } from '@langchain/core/documents'

import pkg from '../package.json' with { type: 'json' }

import { escJsonPathKey, vectorToBytes } from './encoding.js'
import {
	YDBVectorStoreArgumentError,
	YDBVectorStoreConfigError,
	YDBVectorStoreOperationError,
} from './errors.js'

/**
 * KNN search strategy passed to the YDB `Knn::*` UDF.
 *
 * **Similarity strategies** (suffix `Similarity`) return higher values for
 * more similar vectors. Results are sorted **DESC** — the best match is first.
 *
 * **Distance strategies** (suffix `Distance`) return lower values for closer
 * vectors. Results are sorted **ASC** — the best match is first.
 *
 * | Strategy |
 * |---|
 * | `CosineDistance` |
 * | `CosineSimilarity` |
 * | `EuclideanDistance` |
 * | `ManhattanDistance` |
 * | `InnerProductSimilarity` |
 */
export const YDBSearchStrategy = {
	CosineDistance: 'CosineDistance',
	CosineSimilarity: 'CosineSimilarity',
	ManhattanDistance: 'ManhattanDistance',
	EuclideanDistance: 'EuclideanDistance',
	InnerProductSimilarity: 'InnerProductSimilarity',
} as const

export type YDBSearchStrategyType = (typeof YDBSearchStrategy)[keyof typeof YDBSearchStrategy]

/**
 * Maps each strategy to its `WITH` clause fragment for `vector_kmeans_tree`
 * index DDL. `Record` enforces exhaustiveness at compile time — a new strategy
 * added to {@link YDBSearchStrategy} must be added here too.
 */
const INDEX_STRATEGY_DDL: Record<YDBSearchStrategyType, string> = {
	CosineSimilarity: "similarity = 'cosine'",
	InnerProductSimilarity: "similarity = 'inner_product'",
	CosineDistance: "distance = 'cosine'",
	EuclideanDistance: "distance = 'euclidean'",
	ManhattanDistance: "distance = 'manhattan'",
}

/**
 * Mapping from logical field names to physical column names in the YDB table.
 * Override any field via `columnMap` in the store config when the table
 * schema uses non-default names.
 */
export interface YDBColumnMap {
	/** Primary key column — stores the document ID. Default: `"id"`. */
	id: string
	/** Column that holds the document text (`Utf8`). Default: `"document"`. */
	document: string
	/** Column that holds arbitrary document metadata as JSON. Default: `"metadata"`. */
	metadata: string
	/** Column that holds the packed `Float32` embedding bytes (`String`). Default: `"embedding"`. */
	embedding: string
}

/** Common options, independent of how the driver is provided. */
export interface YDBVectorStoreBaseConfig {
	/** YDB table name. Defaults to `"langchain_vectors"`. */
	table?: string
	/**
	 * Override individual column names when the table was not created by this
	 * store (e.g. you have an existing schema). Only the fields you specify are
	 * overridden — omitted fields keep their defaults.
	 */
	columnMap?: Partial<YDBColumnMap>
	/**
	 * Vector similarity/distance function used in KNN search.
	 * Defaults to `YDBSearchStrategy.CosineSimilarity`.
	 * See {@link YDBSearchStrategy} for the full list and sort-order semantics.
	 */
	strategy?: YDBSearchStrategyType
	/**
	 * When `true`, every schema-initialisation step issues `DROP TABLE IF EXISTS`
	 * before `CREATE TABLE`. Useful during development or testing for a
	 * guaranteed fresh start. Defaults to `false`.
	 */
	dropExistingTable?: boolean
	/**
	 * Number of documents flushed per `UPSERT` batch in {@link YDBVectorStore.addVectors}.
	 * Must be a positive integer. Defaults to `32`.
	 */
	batchSize?: number
}

/**
 * Vector-index options. When `indexEnabled` is omitted or `false`, the store
 * does exact KNN scans and the index-tuning fields are not accepted. When
 * `indexEnabled: true`, `indexVectorDimension` is required and the rest of the
 * `index*` fields become available.
 */
export type YDBVectorStoreIndexOptions =
	| {
			indexEnabled?: false
			indexName?: never
			indexVectorDimension?: never
			indexConfigLevels?: never
			indexConfigClusters?: never
			indexTreeSearchTopSize?: never
	  }
	| {
			/**
			 * Enable the `vector_kmeans_tree` approximate nearest-neighbour index.
			 * Call {@link YDBVectorStore.createVectorIndex} after inserting the
			 * initial batch of documents to build the index.
			 */
			indexEnabled: true
			/** Name of the vector index. Defaults to `"langchain_vector_index"`. */
			indexName?: string
			/**
			 * Number of dimensions in the embedding vectors. Required because
			 * YDB needs the size at index-build time. Get it from your embeddings
			 * model docs or via `(await embeddings.embedQuery('x')).length`.
			 */
			indexVectorDimension: number
			/**
			 * Number of tree levels in the k-means index. Recommended range: 1–3.
			 * Higher values improve recall at the cost of slower index build time.
			 * Defaults to `2`.
			 */
			indexConfigLevels?: number
			/**
			 * Number of k-means clusters per tree level. Recommended range: 64–512.
			 * Larger values yield finer partitions and better recall, but require
			 * more memory and a longer build. Defaults to `128`.
			 */
			indexConfigClusters?: number
			/**
			 * `KMeansTreeSearchTopSize` PRAGMA value — how many leaf clusters are
			 * visited during an indexed search. Higher values improve recall at the
			 * cost of latency. Defaults to `1`.
			 */
			indexTreeSearchTopSize?: number
	  }

/**
 * Pass either a pre-built Driver (you manage its lifecycle) or a connection
 * string (the store creates and owns the Driver; `await store.close()` when done).
 */
export type YDBVectorStoreDriverOptions =
	| {
			/** A ready-to-use Driver instance from `@ydbjs/core`. */
			driver: Driver
			connectionString?: never
			driverOptions?: never
	  }
	| {
			/**
			 * YDB connection string, e.g. `"grpc://localhost:2136/local"`.
			 * The store creates a Driver internally; `await store.close()` to release it.
			 */
			connectionString: string
			/** Additional Driver options (auth, TLS, …). */
			driverOptions?: DriverOptions
			driver?: never
	  }

export type YDBVectorStoreConfig = YDBVectorStoreBaseConfig &
	YDBVectorStoreIndexOptions &
	YDBVectorStoreDriverOptions

/**
 * Config for {@link YDBVectorStore.fromExistingTable}. Like
 * {@link YDBVectorStoreConfig} but `table` is required (connecting to "the
 * existing table" without naming it is almost always a footgun) and
 * `dropExistingTable` is forbidden (it would defeat the purpose).
 */
export type YDBVectorStoreExistingTableConfig = Omit<
	YDBVectorStoreBaseConfig,
	'table' | 'dropExistingTable'
> & {
	table: string
	dropExistingTable?: never
} & YDBVectorStoreIndexOptions &
	YDBVectorStoreDriverOptions

/**
 * Metadata filter for similarity search.
 *
 * Each key-value pair is translated to a
 * `JSON_VALUE(metadata, '$.key') = 'value'` condition.
 * Multiple entries are combined with `AND`.
 *
 * **Limitations:**
 * - Values must be strings (JSON scalars are compared as text).
 * - Cannot be used together with `indexEnabled: true` — the vector index
 *   does not support pre-filtering.
 */
export type YDBFilter = Record<string, string>

/**
 * Parameters for {@link YDBVectorStore.delete}. `deleteAll: true` truncates the
 * table; otherwise rows matching `ids` are removed. Empty/omitted `ids` is a
 * no-op.
 */
export type YDBVectorStoreDeleteParams = {
	ids?: string[]
	deleteAll?: boolean
}

function assertSameLength(nameA: string, lenA: number, nameB: string, lenB: number): void {
	if (lenA !== lenB) {
		throw new YDBVectorStoreArgumentError(
			`${nameA}.length (${lenA}) must equal ${nameB}.length (${lenB}).`
		)
	}
}

function assertPositiveInteger(option: string, value: number): void {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new YDBVectorStoreConfigError(`${option} must be a positive integer, got: ${value}.`)
	}
}

function assertNonNegativeInteger(name: string, value: number): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new YDBVectorStoreArgumentError(
			`${name} must be a non-negative integer, got: ${value}.`
		)
	}
}

/**
 * Resolved snapshot of {@link YDBVectorStoreIndexOptions} with defaults applied
 * and tuning values validated. Fields are always populated; when the index is
 * disabled they hold defaults that are never read (callers gate on `enabled`).
 */
class YDBVectorIndexConfig {
	readonly enabled: boolean
	readonly name: string
	readonly levels: number
	readonly clusters: number
	readonly vectorDimension: number | undefined
	readonly treeSearchTopSize: number

	constructor(opts: YDBVectorStoreIndexOptions) {
		if (opts.indexEnabled) {
			this.enabled = true
			this.name = opts.indexName ?? 'langchain_vector_index'
			this.levels = opts.indexConfigLevels ?? 2
			this.clusters = opts.indexConfigClusters ?? 128
			this.vectorDimension = opts.indexVectorDimension
			this.treeSearchTopSize = opts.indexTreeSearchTopSize ?? 1

			assertPositiveInteger('indexVectorDimension', this.vectorDimension)
			assertPositiveInteger('indexConfigLevels', this.levels)
			assertPositiveInteger('indexConfigClusters', this.clusters)
			assertPositiveInteger('indexTreeSearchTopSize', this.treeSearchTopSize)
		} else {
			this.enabled = false
			this.name = 'langchain_vector_index'
			this.levels = 2
			this.clusters = 128
			this.vectorDimension = undefined
			this.treeSearchTopSize = 1
		}
	}

	/** Type-narrowing guard. After `if (cfg.isEnabled())`, `vectorDimension` is `number`. */
	isEnabled(): this is YDBVectorIndexConfig & { vectorDimension: number } {
		return this.enabled
	}
}

/**
 * LangChain vector store backed by YDB. See the package README for usage examples.
 *
 * Uses `@ydbjs/core` (Driver) and `@ydbjs/query` (tagged-template YQL client) —
 * both are bundled as regular dependencies of this package. Embeddings are
 * stored as packed little-endian `Float32` bytes in a `String` column and
 * searched with the built-in `Knn::*` UDFs.
 */
export class YDBVectorStore extends VectorStore {
	declare FilterType: YDBFilter

	#sql: QueryClient
	#driver: Driver
	#promise: Promise<void> | undefined
	#ownedDriver: boolean

	#table: string
	#columnMap: YDBColumnMap

	#strategy: YDBSearchStrategyType

	#batchSize: number

	#indexConfig: YDBVectorIndexConfig

	#dropExistingTable: boolean

	#closed: boolean = false

	override _vectorstoreType(): string {
		return 'ydb'
	}

	constructor(embeddings: EmbeddingsInterface, config: YDBVectorStoreConfig) {
		super(embeddings, config)

		// Branch on `driver` first so that callers passing
		// `{ driver, connectionString: undefined }` (or any partially-undefined
		// union shape) land on the right path.
		if ('driver' in config && config.driver !== undefined) {
			this.#driver = config.driver
			this.#ownedDriver = false
		} else if ('connectionString' in config && config.connectionString) {
			this.#driver = new Driver(config.connectionString, config.driverOptions)
			this.#ownedDriver = true
		} else {
			throw new YDBVectorStoreConfigError(
				'Either `driver` or a non-empty `connectionString` must be provided.'
			)
		}

		this.#driver[kRegisterLibrary]('@ydbjs/langchain', pkg.version)
		this.#sql = createQueryClient(this.#driver)

		this.#table = config.table ?? 'langchain_vectors'
		this.#columnMap = {
			id: 'id',
			metadata: 'metadata',
			document: 'document',
			embedding: 'embedding',
			...config.columnMap,
		}

		this.#strategy = config.strategy ?? YDBSearchStrategy.CosineSimilarity

		this.#batchSize = config.batchSize ?? 32
		assertPositiveInteger('batchSize', this.#batchSize)

		this.#indexConfig = new YDBVectorIndexConfig(config)

		this.#dropExistingTable = config.dropExistingTable ?? false
	}

	get #t(): UnsafeString {
		return identifier(this.#table)
	}

	// Similarity strategies sort highest-first; distance strategies lowest-first.
	get #sortOrder(): 'ASC' | 'DESC' {
		return this.#strategy.endsWith('Similarity') ? 'DESC' : 'ASC'
	}

	#assertOpen(): void {
		if (this.#closed) {
			throw new YDBVectorStoreOperationError('Store is closed.')
		}
	}

	async #ensureTable(): Promise<void> {
		this.#assertOpen()
		this.#promise ??= this.#runInit()
		await this.#promise
	}

	async #runInit(): Promise<void> {
		await this.#driver.ready()
		let { id, document: doc, embedding: emb, metadata: meta } = this.#columnMap

		if (this.#dropExistingTable) {
			await this.#sql`DROP TABLE IF EXISTS ${this.#t}`
		}

		await this.#sql`CREATE TABLE IF NOT EXISTS ${this.#t} (
	        ${identifier(id)}   Utf8,
	        ${identifier(doc)}  Utf8,
	        ${identifier(emb)}  String,
	        ${identifier(meta)} Json,
	        PRIMARY KEY (${identifier(id)})
		)`
	}

	/**
	 * Insert or replace documents using pre-computed embedding vectors.
	 *
	 * Uses `UPSERT` semantics: if a document with the same ID already exists it
	 * is overwritten, not duplicated.  Documents without an explicit `id` receive
	 * a random UUID.
	 *
	 * @param vectors - Embedding vectors, one per document (same order).
	 * @param documents - Documents to store.
	 * @returns The ID of every inserted/updated document (same order as input).
	 */
	async addVectors(vectors: number[][], documents: Document[]): Promise<string[]> {
		assertSameLength('vectors', vectors.length, 'documents', documents.length)

		if (vectors.length === 0) return []

		await this.#ensureTable()

		// Single source of truth for column ↔ JS-key ↔ SQL-expression mapping.
		// Positions must align: UPSERT cols[i] receives the value from selectExprs[i],
		// which reads JS-key `selectExprs[i]` from each `batch` element.
		let mappings: Array<[destCol: string, selectExpr: string]> = [
			[this.#columnMap.id, 'id'],
			[this.#columnMap.document, 'document'],
			[this.#columnMap.embedding, 'embedding'],
			[this.#columnMap.metadata, 'CAST(metadata AS Json)'],
		]
		let destCols = join(
			mappings.map(([d]) => fragment`${identifier(d)}`),
			', '
		)
		let selectExprs = mappings.map(([, e]) => e).join(', ')

		let ids: string[] = []

		for (let i = 0; i < vectors.length; i += this.#batchSize) {
			let batch = documents.slice(i, i + this.#batchSize).map((d, j) => {
				let docId = d.id ?? crypto.randomUUID()
				ids.push(docId)
				return {
					id: docId,
					document: d.pageContent,
					metadata: JSON.stringify(d.metadata ?? {}),
					embedding: vectorToBytes(vectors[i + j]!),
				}
			})

			// Batches are sent sequentially to avoid overwhelming the server.
			// oxlint-disable-next-line no-await-in-loop
			await this.#sql`
				UPSERT INTO ${this.#t} (${destCols})
				SELECT ${unsafe(selectExprs)}
				FROM AS_TABLE(${batch})
			`
		}

		return ids
	}

	/**
	 * Embed and store documents.
	 *
	 * Embeds each document's `pageContent` with the configured embeddings model,
	 * then delegates to {@link addVectors}.  Uses `UPSERT` semantics.
	 *
	 * @param documents - Documents to embed and store.
	 * @returns The ID of every inserted/updated document (same order as input).
	 */
	async addDocuments(documents: Document[]): Promise<string[]> {
		let texts = documents.map((d) => d.pageContent)
		let vectors = await this.embeddings.embedDocuments(texts)
		return this.addVectors(vectors, documents)
	}

	/**
	 * Find the `k` documents most similar to a pre-computed query vector.
	 *
	 * @param query - The query embedding vector.
	 * @param k - Maximum number of results to return.
	 * @param filter - Optional metadata filter (see {@link YDBFilter}).
	 *   Cannot be combined with `indexEnabled: true`.
	 * @returns Pairs of `[document, score]` sorted by the configured strategy:
	 *   descending for similarity strategies, ascending for distance strategies.
	 */
	async similaritySearchVectorWithScore(
		query: number[],
		k: number,
		filter?: this['FilterType']
	): Promise<[Document, number][]> {
		assertNonNegativeInteger('k', k)
		await this.#ensureTable()

		let { id, document: doc, embedding: emb, metadata: meta } = this.#columnMap

		if (filter && Object.keys(filter).length > 0 && this.#indexConfig.enabled) {
			throw new YDBVectorStoreOperationError(
				'Cannot use metadata filter with vector index enabled.'
			)
		}

		// Compose the query from fragments so embedding bytes, filter values, and
		// LIMIT all flow through bound parameters — query text stays stable across
		// k values and filter shapes, letting YDB reuse its compiled plan.
		// JSON path keys cannot be parameterised in YQL, so we escape them and
		// splice them in as raw text via unsafe().
		let pragma: Fragment = this.#indexConfig.enabled
			? fragment`PRAGMA ydb.KMeansTreeSearchTopSize = "${unsafe(String(this.#indexConfig.treeSearchTopSize))}"; `
			: fragment``

		let view: Fragment = this.#indexConfig.enabled
			? fragment`VIEW ${identifier(this.#indexConfig.name)}`
			: fragment``

		let filterEntries = Object.entries(filter ?? {})
		let where: Fragment =
			filterEntries.length > 0
				? fragment`WHERE ${join(
						filterEntries.map(
							([key, value]) =>
								fragment`JSON_VALUE(${identifier(meta)}, ${unsafe(`'$.${escJsonPathKey(key)}'`)}) = ${value}`
						),
						' AND '
					)}`
				: fragment``

		type SearchResultRow = {
			id: string
			document: string
			// Json column — string when the driver returns raw text, parsed value otherwise.
			metadata: string | Record<string, unknown> | null
			score: number
		}

		let [rows = []] = await this.#sql<[SearchResultRow]>`
			${pragma}
			SELECT
				${identifier(id)} AS id,
				${identifier(doc)} AS document,
				${identifier(meta)} AS metadata,
				Knn::${unsafe(this.#strategy)}(${identifier(emb)}, ${vectorToBytes(query)}) AS score
			FROM ${this.#t} ${view}
			${where}
			ORDER BY score ${unsafe(this.#sortOrder)} LIMIT ${new Uint64(BigInt(k))}
		`

		return rows.map((row) => [
			new Document({
				id: row.id,
				pageContent: row.document,
				metadata:
					typeof row.metadata === 'string'
						? JSON.parse(row.metadata)
						: (row.metadata ?? {}),
			}),
			Number(row.score),
		])
	}

	/**
	 * Delete documents from the store. With no matching params (both `ids` and
	 * `deleteAll` omitted, or `ids` is an empty array) it's a no-op — the table
	 * is not touched and not lazily created.
	 *
	 * @param params.ids - Delete only the documents with these IDs.
	 *   An empty array is treated as "nothing to delete".
	 * @param params.deleteAll - When `true`, truncate the entire table.
	 *   Takes precedence over `ids`.
	 */
	override async delete(params: YDBVectorStoreDeleteParams): Promise<void> {
		if (params.deleteAll) {
			await this.#ensureTable()
			await this.#sql`DELETE FROM ${this.#t}`
		} else if (params.ids && params.ids.length > 0) {
			await this.#ensureTable()
			let col = identifier(this.#columnMap.id)
			await this.#sql`DELETE FROM ${this.#t} WHERE ${col} IN ${params.ids}`
		}
	}

	/**
	 * Drop the backing YDB table (`DROP TABLE IF EXISTS`).
	 * All data is permanently deleted. The store can be reused after this call —
	 * the next operation re-creates the table (without re-dropping).
	 */
	async drop(): Promise<void> {
		this.#assertOpen()
		await this.#driver.ready()
		// Wait out any in-flight CREATE TABLE so DROP doesn't race with it.
		try {
			await this.#promise
		} catch {
			// Init failure is irrelevant — we're dropping the table anyway.
		}
		await this.#sql`DROP TABLE IF EXISTS ${this.#t}`
		this.#promise = undefined
	}

	/**
	 * Build a `vector_kmeans_tree` approximate nearest-neighbour index on the
	 * embedding column.
	 *
	 * **When to call:** after inserting the initial batch of documents and before
	 * the store goes into production.  Documents added after index creation are
	 * still searchable — YDB scans them without the index, then merges results.
	 *
	 * **Trade-off:** the index enables sub-linear search at the cost of recall.
	 * Tune `indexConfigLevels`, `indexConfigClusters`, and
	 * `indexTreeSearchTopSize` to balance speed vs. accuracy.
	 *
	 * Requires `indexEnabled: true` AND `indexVectorDimension` in the store config.
	 * Throws if the index already exists (re-building requires dropping first).
	 */
	async createVectorIndex(): Promise<void> {
		if (!this.#indexConfig.isEnabled()) {
			throw new YDBVectorStoreOperationError(
				'Cannot create vector index: indexEnabled is false in config.'
			)
		}
		await this.#ensureTable()

		let index = this.#indexConfig
		await this.#sql`
			ALTER TABLE ${this.#t}
			ADD INDEX ${identifier(index.name)}
			GLOBAL USING vector_kmeans_tree
			ON (${identifier(this.#columnMap.embedding)})
			WITH (
				${this.#sql.unsafe(INDEX_STRATEGY_DDL[this.#strategy])},
				vector_type = 'float',
				vector_dimension=${this.#sql.unsafe(String(index.vectorDimension))},
				levels=${this.#sql.unsafe(String(index.levels))},
				clusters=${this.#sql.unsafe(String(index.clusters))}
			)
		`
	}

	/**
	 * Drain the QueryClient session pool, then close the Driver if this store
	 * owns it. Idempotent. When an external `driver` was provided, only the
	 * pool is released — the caller owns the Driver lifecycle.
	 */
	async close(): Promise<void> {
		if (this.#closed) return
		this.#closed = true
		await this.#sql[Symbol.asyncDispose]()
		if (this.#ownedDriver) {
			this.#driver.close()
		}
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.close()
	}

	/**
	 * Create a store, embed the provided texts, and insert them in one step.
	 *
	 * @param texts - Raw text strings to embed and store.
	 * @param metadatas - A single metadata object (applied to all texts) or one
	 *   object per text.
	 * @param embeddings - Embeddings model used to vectorise the texts.
	 * @param config - Store configuration (connection + table options).
	 * @returns A ready-to-use store containing the inserted documents.
	 */
	static override async fromTexts(
		texts: string[],
		metadatas: object | object[],
		embeddings: EmbeddingsInterface,
		config: YDBVectorStoreConfig
	): Promise<YDBVectorStore> {
		let docs = texts.map(
			(text, i) =>
				new Document({
					pageContent: text,
					metadata: Array.isArray(metadatas) ? metadatas[i] : metadatas,
				})
		)
		return YDBVectorStore.fromDocuments(docs, embeddings, config)
	}

	/**
	 * Create a store, embed the provided documents, and insert them in one step.
	 *
	 * @param docs - Documents to embed and store.
	 * @param embeddings - Embeddings model used to vectorise the document text.
	 * @param config - Store configuration (connection + table options).
	 * @returns A ready-to-use store containing the inserted documents.
	 */
	static override async fromDocuments(
		docs: Document[],
		embeddings: EmbeddingsInterface,
		config: YDBVectorStoreConfig
	): Promise<YDBVectorStore> {
		let store = new YDBVectorStore(embeddings, config)
		await store.addDocuments(docs)
		return store
	}

	/**
	 * Connect to an existing YDB table without running `CREATE TABLE`.
	 *
	 * Use this when the table was created by a previous store instance or by
	 * external tooling and you want to search or insert without re-initialising
	 * the schema. `columnMap`, `strategy`, and any index options must match how
	 * the table was originally created.
	 *
	 * @param embeddings - Embeddings model (must produce the same dimension as
	 *   the stored vectors).
	 * @param config - Store configuration. `table` is required;
	 *   `dropExistingTable` is forbidden — call the constructor if you need to
	 *   drop.
	 * @returns A store instance whose table-creation step is already marked done.
	 */
	static fromExistingTable(
		embeddings: EmbeddingsInterface,
		config: YDBVectorStoreExistingTableConfig
	): YDBVectorStore {
		let store = new YDBVectorStore(embeddings, config)
		store.#markInitialized()
		return store
	}

	#markInitialized(): void {
		this.#promise = Promise.resolve()
	}
}
