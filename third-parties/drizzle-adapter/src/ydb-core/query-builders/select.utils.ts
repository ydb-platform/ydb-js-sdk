import { is } from 'drizzle-orm/entity'
import { SelectionProxyHandler } from 'drizzle-orm/selection-proxy'
import { SQL, type SQLWrapper, View } from 'drizzle-orm/sql/sql'
import { Subquery } from 'drizzle-orm/subquery'
import { Table } from 'drizzle-orm/table'
import type { YdbTable } from '../table.js'
import { getTableColumns } from './utils.js'
import type { SelectFields } from './select.types.js'

export function normalizeSqlWrapperArray(
	values: SQLWrapper[] | SQLWrapper | undefined
): SQLWrapper[] | undefined {
	if (values === undefined) {
		return undefined
	}

	return Array.isArray(values) ? values : [values]
}

export function getTableLikeName(table: unknown): string | undefined {
	if (is(table, Subquery)) {
		return table._.alias
	}

	if (is(table, View)) {
		return table._.name
	}

	if (is(table, Table)) {
		return (table as any)[(Table as any).Symbol.Name]
	}

	return undefined
}

export function getSourceSelection(source: unknown): SelectFields {
	if (is(source, Subquery)) {
		return Object.fromEntries(
			Object.keys(source._.selectedFields).map((key) => [
				key,
				(source as unknown as Record<string, unknown>)[key],
			])
		)
	}

	if (is(source, View)) {
		return source._.selectedFields
	}

	if (is(source, SQL)) {
		return {}
	}

	return getTableColumns(source as YdbTable)
}

export function normalizeCountValue(value: number, methodName: string): number {
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`YDB ${methodName}() expects a non-negative finite number`)
	}

	return value
}

export function createSelectionProxy(fields: SelectFields, sqlAliasedBehavior: 'sql' | 'alias') {
	return new Proxy(
		fields,
		new SelectionProxyHandler({
			sqlAliasedBehavior,
			sqlBehavior: 'sql',
		})
	)
}
