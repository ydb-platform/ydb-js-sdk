import { is } from 'drizzle-orm/entity'
import { Param, SQL, sql as yql } from 'drizzle-orm/sql/sql'
import { Table } from 'drizzle-orm/table'
import type { YdbColumn } from '../columns/common.js'
import type { YdbTable } from '../table.js'
import { getTableConfig } from '../table.utils.js'

type TableColumns = Record<string, YdbColumn>

export function getTableColumns(table: YdbTable): TableColumns {
	return ((table as any)[(Table as any).Symbol.Columns] ?? {}) as TableColumns
}

export function validateTableColumnKeys(
	table: YdbTable,
	input: Record<string, unknown>,
	operation: 'insert' | 'update' | 'upsert' | 'replace'
): void {
	const columns = getTableColumns(table)

	for (const key of Object.keys(input)) {
		if (!(key in columns)) {
			throw new Error(`Unknown column "${key}" in ${operation}()`)
		}
	}
}

export function getPrimaryColumnKeys(table: YdbTable): string[] {
	const columns = getTableColumns(table)
	const primaryColumns = new Set<YdbColumn>()

	for (const column of Object.values(columns)) {
		if (column.primary) {
			primaryColumns.add(column)
		}
	}

	for (const primaryKey of getTableConfig(table as any).primaryKeys) {
		for (const column of primaryKey.config.columns) {
			primaryColumns.add(column)
		}
	}

	return Object.entries(columns)
		.filter(([, column]) => primaryColumns.has(column))
		.map(([key]) => key)
}

export function validateSetBasedMutationSelection(
	table: YdbTable,
	fields: Record<string, unknown> | undefined,
	operation: 'update' | 'delete'
): void {
	const label = operation === 'update' ? 'Update on' : 'Delete on'

	if (!fields || Object.keys(fields).length === 0) {
		throw new Error(`${label} error: selected fields must include table columns`)
	}

	const columns = getTableColumns(table)
	const selectedKeys = Object.keys(fields)
	for (const key of selectedKeys) {
		if (!(key in columns)) {
			throw new Error(
				`${label} error: selected field "${key}" is not a column of the target table`
			)
		}
	}

	const primaryKeys = getPrimaryColumnKeys(table)
	if (primaryKeys.length === 0) {
		throw new Error(`YDB ${operation}().on() requires at least one primary key column`)
	}

	for (const key of primaryKeys) {
		if (!selectedKeys.includes(key)) {
			throw new Error(
				`YDB ${operation}().on() requires primary key column "${key}" in selected fields`
			)
		}
	}
}

export function getInsertColumnEntries(table: YdbTable): Array<[string, YdbColumn]> {
	return Object.entries(getTableColumns(table)).filter(
		([, column]) => !(column as any).shouldDisableInsert?.()
	)
}

export function resolveInsertValue(column: YdbColumn, value: unknown): unknown {
	if (value === undefined || (is(value, Param) && value.value === undefined)) {
		if (column.defaultFn !== undefined) {
			const defaultValue = column.defaultFn()
			return is(defaultValue, SQL) ? defaultValue : yql.param(defaultValue, column)
		}

		if (column.default !== undefined) {
			return is(column.default, SQL) ? column.default : yql.param(column.default, column)
		}

		if (column.onUpdateFn !== undefined) {
			const onUpdateValue = column.onUpdateFn()
			return is(onUpdateValue, SQL) ? onUpdateValue : yql.param(onUpdateValue, column)
		}

		return yql`default`
	}

	return is(value, SQL) || is(value, Param) ? value : yql.param(value, column)
}

export function resolveUpdateValue(column: YdbColumn, value: unknown): unknown {
	if (value !== undefined) {
		return is(value, SQL) || is(value, Param) ? value : yql.param(value, column)
	}

	if (column.onUpdateFn !== undefined) {
		const onUpdateValue = column.onUpdateFn()
		return is(onUpdateValue, SQL) ? onUpdateValue : yql.param(onUpdateValue, column)
	}

	return undefined
}
