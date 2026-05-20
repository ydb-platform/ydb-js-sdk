import { entityKind } from 'drizzle-orm/entity'
import { getTableName } from 'drizzle-orm/table'
import type { YdbColumn } from './columns/common.js'
import type { YdbTable } from './table.js'

export function uniqueKeyName(table: YdbTable, columns: readonly string[]): string {
	return `${getTableName(table)}_${columns.join('_')}_unique`
}

function defaultUniqueName(table: YdbTable, columns: readonly YdbColumn[]): string {
	return uniqueKeyName(
		table,
		columns.map((column) => column.name)
	)
}

function assertColumnsBelongToTable(table: YdbTable, columns: readonly YdbColumn[]): void {
	let tableName = getTableName(table)

	for (let column of columns) {
		if (column.table !== table) {
			throw new Error(
				`Unique constraint column "${column.name}" does not belong to table "${tableName}"`
			)
		}
	}
}

export interface YdbUniqueConstraintConfig {
	readonly table: YdbTable
	readonly columns: readonly YdbColumn[]
	readonly name: string
}

export class YdbUniqueConstraintBuilderOn {
	static readonly [entityKind] = 'YdbUniqueConstraintBuilderOn'

	readonly #name: string | undefined

	constructor(name: string | undefined) {
		this.#name = name
	}

	on(...columns: [YdbColumn, ...YdbColumn[]]): YdbUniqueConstraintBuilder {
		return new YdbUniqueConstraintBuilder(this.#name, columns)
	}
}

export class YdbUniqueConstraintBuilder {
	static readonly [entityKind] = 'YdbUniqueConstraintBuilder'

	readonly #name: string | undefined
	readonly #columns: [YdbColumn, ...YdbColumn[]]

	constructor(name: string | undefined, columns: [YdbColumn, ...YdbColumn[]]) {
		this.#name = name
		this.#columns = columns
	}

	build(table: YdbTable): YdbUniqueConstraint {
		assertColumnsBelongToTable(table, this.#columns)

		return new YdbUniqueConstraint({
			table,
			columns: [...this.#columns],
			name: this.#name ?? defaultUniqueName(table, this.#columns),
		})
	}
}

export class YdbUniqueConstraint {
	static readonly [entityKind] = 'YdbUniqueConstraint'

	constructor(readonly config: YdbUniqueConstraintConfig) {}
}

export function unique(name?: string): YdbUniqueConstraintBuilderOn {
	return new YdbUniqueConstraintBuilderOn(name)
}
