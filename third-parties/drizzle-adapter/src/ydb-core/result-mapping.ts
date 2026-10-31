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
	let pathKey = path[path.length - 1]

	if (is(field, Column)) {
		if (Object.hasOwn(row, field.name)) {
			return row[field.name]
		}

		if (pathKey && Object.hasOwn(row, pathKey)) {
			return row[pathKey]
		}
	} else if (is(field, SQL.Aliased)) {
		if (Object.hasOwn(row, field.fieldAlias)) {
			return row[field.fieldAlias]
		}

		if (pathKey && Object.hasOwn(row, pathKey)) {
			return row[pathKey]
		}
	} else if (pathKey && Object.hasOwn(row, pathKey)) {
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
		let path = pathPrefix ? [...pathPrefix, name] : [name]

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
	let nullifyMap: Record<string, string | false> = Object.create(null)
	let rowValues = rowToArray(columns, row)

	let result = columns.reduce<Record<string, any>>((current, { path, field }, columnIndex) => {
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
		for (let [pathChunkIndex, pathChunk] of path.entries()) {
			if (pathChunkIndex < path.length - 1) {
				if (!Object.hasOwn(node, pathChunk)) {
					Object.defineProperty(node, pathChunk, {
						value: {},
						writable: true,
						enumerable: true,
						configurable: true,
					})
				}
				node = node[pathChunk]
			} else {
				let rawValue = rowValues[columnIndex]
				let value = rawValue === null ? null : decoder.mapFromDriverValue(rawValue)
				Object.defineProperty(node, pathChunk, {
					value,
					writable: true,
					enumerable: true,
					configurable: true,
				})

				if (joinsNotNullableMap && is(field, Column) && path.length === 2) {
					let objectName = path[0]!
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
		for (let [objectName, tableName] of Object.entries(nullifyMap)) {
			if (
				typeof tableName === 'string' &&
				(!Object.hasOwn(joinsNotNullableMap, tableName) || !joinsNotNullableMap[tableName])
			) {
				result[objectName] = null
			}
		}
	}

	return result as TResult
}
