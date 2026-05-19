import { Column } from 'drizzle-orm/column'
import { is } from 'drizzle-orm/entity'
import { SQL } from 'drizzle-orm/sql/sql'
import { Subquery } from 'drizzle-orm/subquery'
import { Table, getTableName } from 'drizzle-orm/table'
import type { YdbColumn } from './columns/common.js'

export type YdbSelectedField = {
	path: string[]
	field: unknown
}

export type YdbSelectedFieldsOrdered = YdbSelectedField[]

function getRowObjectValue(
	row: Record<string, unknown>,
	path: string[],
	field: unknown,
	columnIndex: number
): unknown {
	const pathKey = path[path.length - 1]

	if (is(field, Column)) {
		if (field.name in row) {
			return row[field.name]
		}

		if (pathKey && pathKey in row) {
			return row[pathKey]
		}
	} else if (is(field, SQL.Aliased)) {
		if (field.fieldAlias in row) {
			return row[field.fieldAlias]
		}

		if (pathKey && pathKey in row) {
			return row[pathKey]
		}
	} else if (pathKey && pathKey in row) {
		return row[pathKey]
	}

	return Object.values(row)[columnIndex]
}

export function rowToArray(
	columns: YdbSelectedFieldsOrdered,
	row: unknown[] | Record<string, unknown>
): unknown[] {
	if (Array.isArray(row)) {
		return row
	}

	return columns.map(({ path, field }, columnIndex) =>
		getRowObjectValue(row, path, field, columnIndex)
	)
}

export function orderSelectedFields(
	fields: Record<string, unknown>,
	pathPrefix?: string[]
): YdbSelectedFieldsOrdered {
	return Object.entries(fields).reduce<YdbSelectedFieldsOrdered>((result, [name, field]) => {
		const path = pathPrefix ? [...pathPrefix, name] : [name]

		if (is(field, Column) || is(field, SQL) || is(field, SQL.Aliased) || is(field, Subquery)) {
			result.push({ path, field })
		} else if (is(field, Table)) {
			result.push(...orderSelectedFields((field as any)[(Table as any).Symbol.Columns], path))
		} else {
			result.push(...orderSelectedFields(field as Record<string, unknown>, path))
		}

		return result
	}, [])
}

export function mapResultRow<TResult>(
	columns: YdbSelectedFieldsOrdered,
	row: unknown[] | Record<string, unknown>,
	joinsNotNullableMap?: Record<string, boolean>
): TResult {
	const nullifyMap: Record<string, string | false> = {}
	const rowValues = rowToArray(columns, row)

	const result = columns.reduce<Record<string, any>>((current, { path, field }, columnIndex) => {
		let decoder: { mapFromDriverValue(value: unknown): unknown }

		if (is(field, Column)) {
			decoder = field as unknown as YdbColumn
		} else if (is(field, SQL)) {
			decoder = (field as any).decoder
		} else if (is(field, Subquery)) {
			decoder = (field as any)._.sql.decoder
		} else {
			decoder = (field as any).sql.decoder
		}

		let node = current
		for (const [pathChunkIndex, pathChunk] of path.entries()) {
			if (pathChunkIndex < path.length - 1) {
				if (!(pathChunk in node)) {
					node[pathChunk] = {}
				}
				node = node[pathChunk]
			} else {
				const rawValue = rowValues[columnIndex]
				const value = rawValue === null ? null : decoder.mapFromDriverValue(rawValue)
				node[pathChunk] = value

				if (joinsNotNullableMap && is(field, Column) && path.length === 2) {
					const objectName = path[0]!
					if (!(objectName in nullifyMap)) {
						nullifyMap[objectName] = value === null ? getTableName(field.table) : false
					} else if (
						typeof nullifyMap[objectName] === 'string' &&
						nullifyMap[objectName] !== getTableName(field.table)
					) {
						nullifyMap[objectName] = false
					}
				}
			}
		}

		return current
	}, {})

	if (joinsNotNullableMap && Object.keys(nullifyMap).length > 0) {
		for (const [objectName, tableName] of Object.entries(nullifyMap)) {
			if (typeof tableName === 'string' && !joinsNotNullableMap[tableName]) {
				result[objectName] = null
			}
		}
	}

	return result as TResult
}
