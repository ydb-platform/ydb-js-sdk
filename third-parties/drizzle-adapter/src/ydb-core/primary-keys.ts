import { entityKind } from 'drizzle-orm/entity'
import { getTableName } from 'drizzle-orm/table'
import type { YdbColumn } from './columns/common.js'
import type { YdbTable } from './table.js'

function assertColumnsBelongToTable(table: YdbTable, columns: readonly YdbColumn[]): void {
	const tableName = getTableName(table)

	for (const column of columns) {
		if (column.table !== table) {
			throw new Error(
				`Primary key column "${column.name}" does not belong to table "${tableName}"`
			)
		}
	}
}

export interface YdbPrimaryKeyConfig {
	readonly table: YdbTable
	readonly columns: readonly YdbColumn[]
}

export class YdbPrimaryKeyBuilder {
	static readonly [entityKind] = 'YdbPrimaryKeyBuilder'

	constructor(private readonly columns: [YdbColumn, ...YdbColumn[]]) {}

	build(table: YdbTable): YdbPrimaryKey {
		assertColumnsBelongToTable(table, this.columns)
		return new YdbPrimaryKey({
			table,
			columns: [...this.columns],
		})
	}
}

export class YdbPrimaryKey {
	static readonly [entityKind] = 'YdbPrimaryKey'

	constructor(readonly config: YdbPrimaryKeyConfig) {}
}

export function primaryKey(...columns: [YdbColumn, ...YdbColumn[]]): YdbPrimaryKeyBuilder {
	return new YdbPrimaryKeyBuilder(columns)
}
