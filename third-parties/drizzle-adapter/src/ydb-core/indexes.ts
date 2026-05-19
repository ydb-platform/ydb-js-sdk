import { entityKind } from 'drizzle-orm/entity'
import { type SQL, sql as yql } from 'drizzle-orm/sql/sql'
import { getTableName } from 'drizzle-orm/table'
import type { YdbColumn } from './columns/common.js'
import type { YdbTable } from './table.js'

export type YdbIndexLocality = 'GLOBAL' | 'LOCAL'
export type YdbIndexSyncMode = 'SYNC' | 'ASYNC'
export type YdbVectorType = 'float' | 'uint8' | 'int8'
export type YdbVectorDistance = 'cosine' | 'manhattan' | 'euclidean'
export type YdbVectorSimilarity = 'inner_product' | 'cosine'

export interface YdbIndexWithOptions {
	[key: string]: string | number | boolean
}

export interface YdbVectorKMeansTreeOptions {
	vectorDimension: number
	vectorType: YdbVectorType
	distance?: YdbVectorDistance
	similarity?: YdbVectorSimilarity
	clusters: number
	levels: number
}

export interface YdbIndexConfig {
	readonly name?: string | undefined
	readonly table: YdbTable
	readonly columns: readonly YdbColumn[]
	readonly unique: boolean
	readonly locality: YdbIndexLocality
	readonly sync: YdbIndexSyncMode
	readonly indexType?: string | undefined
	readonly cover: readonly YdbColumn[]
	readonly withOptions: Readonly<Record<string, string | number | boolean>>
}

interface YdbIndexBuilderDefaults {
	readonly indexType?: string | undefined
	readonly withOptions?: YdbIndexWithOptions | undefined
}

const vectorKMeansTreeIndexType = 'vector_kmeans_tree'
const vectorTypes: readonly YdbVectorType[] = ['float', 'uint8', 'int8']
const vectorDistances: readonly YdbVectorDistance[] = ['cosine', 'manhattan', 'euclidean']
const vectorSimilarities: readonly YdbVectorSimilarity[] = ['inner_product', 'cosine']

function assertColumnsBelongToTable(
	table: YdbTable,
	columns: readonly YdbColumn[],
	kind: string
): void {
	const tableName = getTableName(table)

	for (const column of columns) {
		if (column.table !== table) {
			throw new Error(
				`${kind} column "${column.name}" does not belong to table "${tableName}"`
			)
		}
	}
}

function assertIntegerRange(name: string, value: number, min: number, max: number): void {
	if (!Number.isInteger(value) || value < min || value > max) {
		throw new Error(`YDB vector index ${name} must be an integer between ${min} and ${max}`)
	}
}

function assertOneOf<T extends string>(
	name: string,
	value: string,
	allowed: readonly T[]
): asserts value is T {
	if (!(allowed as readonly string[]).includes(value)) {
		throw new Error(`YDB vector index ${name} must be one of: ${allowed.join(', ')}`)
	}
}

function normalizeVectorKMeansTreeOptions(
	options: YdbVectorKMeansTreeOptions
): YdbIndexWithOptions {
	assertIntegerRange('vectorDimension', options.vectorDimension, 1, 16_384)
	assertIntegerRange('clusters', options.clusters, 2, 2_048)
	assertIntegerRange('levels', options.levels, 1, 16)
	assertOneOf('vectorType', options.vectorType, vectorTypes)

	if ((options.distance === undefined) === (options.similarity === undefined)) {
		throw new Error('YDB vector index requires exactly one of distance or similarity')
	}

	const result: YdbIndexWithOptions = {}
	if (options.distance !== undefined) {
		assertOneOf('distance', options.distance, vectorDistances)
		result['distance'] = options.distance
	} else {
		assertOneOf('similarity', options.similarity!, vectorSimilarities)
		result['similarity'] = options.similarity!
	}

	if (options.clusters ** options.levels > 1_073_741_824) {
		throw new Error('YDB vector index clusters ** levels must be no more than 1073741824')
	}

	if (options.vectorDimension * options.clusters > 4_194_304) {
		throw new Error('YDB vector index vectorDimension * clusters must be no more than 4194304')
	}

	result['vector_type'] = options.vectorType
	result['vector_dimension'] = options.vectorDimension
	result['clusters'] = options.clusters
	result['levels'] = options.levels
	return result
}

export class YdbIndexBuilderOn {
	static readonly [entityKind] = 'YdbIndexBuilderOn'

	constructor(
		private readonly name: string | undefined,
		private readonly unique: boolean,
		private readonly defaults: YdbIndexBuilderDefaults = {}
	) {}

	on(...columns: [YdbColumn, ...YdbColumn[]]): YdbIndexBuilder {
		const builder = new YdbIndexBuilder(this.name, columns, this.unique)

		if (this.defaults.indexType) {
			builder.using(this.defaults.indexType)
		}

		if (this.defaults.withOptions) {
			builder.with(this.defaults.withOptions)
		}

		return builder
	}
}

export class YdbIndexBuilder {
	static readonly [entityKind] = 'YdbIndexBuilder'

	private locality: YdbIndexLocality = 'GLOBAL'
	private syncMode: YdbIndexSyncMode = 'SYNC'
	private indexType?: string
	private coverColumns: YdbColumn[] = []
	private withOptions: YdbIndexWithOptions = {}

	constructor(
		private readonly name: string | undefined,
		private readonly columns: [YdbColumn, ...YdbColumn[]],
		private readonly unique: boolean
	) {}

	global(): this {
		this.locality = 'GLOBAL'
		return this
	}

	local(): this {
		this.locality = 'LOCAL'
		return this
	}

	sync(): this {
		this.syncMode = 'SYNC'
		return this
	}

	async(): this {
		this.syncMode = 'ASYNC'
		return this
	}

	using(indexType: string): this {
		this.indexType = indexType
		return this
	}

	vectorKMeansTree(options: YdbVectorKMeansTreeOptions): this {
		return this.using(vectorKMeansTreeIndexType).with(normalizeVectorKMeansTreeOptions(options))
	}

	cover(...columns: YdbColumn[]): this {
		this.coverColumns = [...columns]
		return this
	}

	with(options: YdbIndexWithOptions): this {
		this.withOptions = { ...this.withOptions, ...options }
		return this
	}

	build(table: YdbTable): YdbIndex {
		assertColumnsBelongToTable(table, this.columns, 'Index')
		assertColumnsBelongToTable(table, this.coverColumns, 'Index cover')

		if (this.indexType === vectorKMeansTreeIndexType) {
			if (this.unique) {
				throw new Error('YDB vector indexes cannot be UNIQUE')
			}

			if (this.locality !== 'GLOBAL') {
				throw new Error('YDB vector indexes support only GLOBAL locality')
			}

			if (this.syncMode !== 'SYNC') {
				throw new Error('YDB vector indexes support only SYNC mode')
			}
		}

		return new YdbIndex({
			name: this.name,
			table,
			columns: [...this.columns],
			unique: this.unique,
			locality: this.locality,
			sync: this.syncMode,
			indexType: this.indexType,
			cover: [...this.coverColumns],
			withOptions: { ...this.withOptions },
		})
	}
}

export class YdbIndex {
	static readonly [entityKind] = 'YdbIndex'

	constructor(readonly config: YdbIndexConfig) {}
}

export function index(name?: string): YdbIndexBuilderOn {
	return new YdbIndexBuilderOn(name, false)
}

export function uniqueIndex(name?: string): YdbIndexBuilderOn {
	return new YdbIndexBuilderOn(name, true)
}

export function vectorIndex(name: string, options: YdbVectorKMeansTreeOptions): YdbIndexBuilderOn
export function vectorIndex(options: YdbVectorKMeansTreeOptions): YdbIndexBuilderOn
export function vectorIndex(
	nameOrOptions: string | YdbVectorKMeansTreeOptions,
	options?: YdbVectorKMeansTreeOptions
): YdbIndexBuilderOn {
	const name = typeof nameOrOptions === 'string' ? nameOrOptions : undefined
	const vectorOptions = typeof nameOrOptions === 'string' ? options : nameOrOptions

	if (!vectorOptions) {
		throw new Error('YDB vectorIndex() requires vector index options')
	}

	return new YdbIndexBuilderOn(name, false, {
		indexType: vectorKMeansTreeIndexType,
		withOptions: normalizeVectorKMeansTreeOptions(vectorOptions),
	})
}

export function indexView(table: YdbTable | string, indexName: string, alias?: string): SQL {
	const tableSql = typeof table === 'string' ? yql.identifier(table) : yql`${table}`
	const aliasSql = alias ? yql` as ${yql.identifier(alias)}` : undefined
	return yql`${tableSql} view ${yql.identifier(indexName)}${aliasSql}`
}

export function vectorIndexView(table: YdbTable | string, indexName: string, alias?: string): SQL {
	return indexView(table, indexName, alias)
}
