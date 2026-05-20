import { entityKind } from 'drizzle-orm/entity'
import type { YdbColumn } from './columns/common.js'
import type { YdbTable } from './table.js'

export type YdbTableOptionValue = string | number | boolean | YdbRawTableOptionValue

export interface YdbRawTableOptionValue {
	readonly kind: 'raw'
	readonly value: string
}

export interface YdbTableOptionsConfig {
	readonly table: YdbTable
	readonly options: Readonly<Record<string, YdbTableOptionValue>>
}

export type YdbPartitioningConfig = {
	readonly table: YdbTable
	readonly type: 'hash'
	readonly columns: readonly YdbColumn[]
}

export type YdbTtlUnit = 'SECONDS' | 'MILLISECONDS' | 'MICROSECONDS' | 'NANOSECONDS'
export type YdbTtlAction =
	| {
			readonly interval: string
			readonly delete?: true
	  }
	| {
			readonly interval: string
			readonly externalDataSource: string
	  }

export interface YdbTtlConfig {
	readonly table: YdbTable
	readonly column: YdbColumn
	readonly actions: readonly YdbTtlAction[]
	readonly unit?: YdbTtlUnit | undefined
}

export type YdbColumnFamilyCompression = 'off' | 'lz4' | 'zstd' | (string & {})
export type YdbColumnFamilyData = 'ssd' | 'rot' | (string & {})

export interface YdbColumnFamilyOptions {
	readonly data?: YdbColumnFamilyData | undefined
	readonly compression?: YdbColumnFamilyCompression | undefined
	readonly compressionLevel?: number | undefined
}

export interface YdbColumnFamilyConfig {
	readonly table: YdbTable
	readonly name: string
	readonly options: YdbColumnFamilyOptions
	readonly columns: readonly YdbColumn[]
}

function assertColumnsBelongToTable(
	table: YdbTable,
	columns: readonly YdbColumn[],
	kind: string
): void {
	for (let column of columns) {
		if (column.table !== table) {
			throw new Error(`${kind} column "${column.name}" does not belong to table`)
		}
	}
}

export function rawTableOption(value: string): YdbRawTableOptionValue {
	return { kind: 'raw', value }
}

export class YdbTableOptionsBuilder {
	static readonly [entityKind] = 'YdbTableOptionsBuilder'

	readonly #options: Readonly<Record<string, YdbTableOptionValue>>

	constructor(options: Readonly<Record<string, YdbTableOptionValue>>) {
		this.#options = options
	}

	build(table: YdbTable): YdbTableOptions {
		return new YdbTableOptions({
			table,
			options: { ...this.#options },
		})
	}
}

export class YdbTableOptions {
	static readonly [entityKind] = 'YdbTableOptions'

	constructor(readonly config: YdbTableOptionsConfig) {}
}

export class YdbPartitioningBuilder {
	static readonly [entityKind] = 'YdbPartitioningBuilder'

	readonly #columns: [YdbColumn, ...YdbColumn[]]

	constructor(columns: [YdbColumn, ...YdbColumn[]]) {
		this.#columns = columns
	}

	build(table: YdbTable): YdbPartitioning {
		assertColumnsBelongToTable(table, this.#columns, 'Partitioning')
		return new YdbPartitioning({
			table,
			type: 'hash',
			columns: [...this.#columns],
		})
	}
}

export class YdbPartitioning {
	static readonly [entityKind] = 'YdbPartitioning'

	constructor(readonly config: YdbPartitioningConfig) {}
}

export class YdbTtlBuilder {
	static readonly [entityKind] = 'YdbTtlBuilder'

	readonly #column: YdbColumn
	readonly #actions: readonly YdbTtlAction[]
	readonly #unit: YdbTtlUnit | undefined

	constructor(column: YdbColumn, actions: readonly YdbTtlAction[], unit?: YdbTtlUnit) {
		this.#column = column
		this.#actions = actions
		this.#unit = unit
	}

	build(table: YdbTable): YdbTtl {
		assertColumnsBelongToTable(table, [this.#column], 'TTL')
		if (this.#actions.length === 0) {
			throw new Error('YDB TTL requires at least one action')
		}

		return new YdbTtl({
			table,
			column: this.#column,
			actions: [...this.#actions],
			unit: this.#unit,
		})
	}
}

export class YdbTtl {
	static readonly [entityKind] = 'YdbTtl'

	constructor(readonly config: YdbTtlConfig) {}
}

export class YdbColumnFamilyBuilder {
	static readonly [entityKind] = 'YdbColumnFamilyBuilder'

	#familyColumns: YdbColumn[] = []

	readonly #name: string
	readonly #options: YdbColumnFamilyOptions

	constructor(name: string, options: YdbColumnFamilyOptions = {}) {
		this.#name = name
		this.#options = options
	}

	columns(...columns: YdbColumn[]): this {
		this.#familyColumns = [...columns]
		return this
	}

	build(table: YdbTable): YdbColumnFamily {
		assertColumnsBelongToTable(table, this.#familyColumns, 'Column family')
		return new YdbColumnFamily({
			table,
			name: this.#name,
			options: { ...this.#options },
			columns: [...this.#familyColumns],
		})
	}
}

export class YdbColumnFamily {
	static readonly [entityKind] = 'YdbColumnFamily'

	constructor(readonly config: YdbColumnFamilyConfig) {}
}

export function tableOptions(
	options: Readonly<Record<string, YdbTableOptionValue>>
): YdbTableOptionsBuilder {
	return new YdbTableOptionsBuilder(options)
}

export function partitionByHash(...columns: [YdbColumn, ...YdbColumn[]]): YdbPartitioningBuilder {
	return new YdbPartitioningBuilder(columns)
}

export function ttl(
	column: YdbColumn,
	interval: string,
	options?: { unit?: YdbTtlUnit }
): YdbTtlBuilder
export function ttl(
	column: YdbColumn,
	actions: [YdbTtlAction, ...YdbTtlAction[]],
	options?: { unit?: YdbTtlUnit }
): YdbTtlBuilder
export function ttl(
	column: YdbColumn,
	intervalOrActions: string | [YdbTtlAction, ...YdbTtlAction[]],
	options: { unit?: YdbTtlUnit } = {}
): YdbTtlBuilder {
	let actions =
		typeof intervalOrActions === 'string'
			? [{ interval: intervalOrActions }]
			: intervalOrActions

	return new YdbTtlBuilder(column, actions, options.unit)
}

export function columnFamily(
	name: string,
	options?: YdbColumnFamilyOptions
): YdbColumnFamilyBuilder {
	return new YdbColumnFamilyBuilder(name, options)
}
