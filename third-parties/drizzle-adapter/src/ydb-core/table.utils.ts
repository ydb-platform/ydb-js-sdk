import { is } from 'drizzle-orm/entity'
import { Table } from 'drizzle-orm/table'
import type { YdbColumn } from './columns/common.js'
import { type YdbIndex, YdbIndexBuilder } from './indexes.js'
import { type YdbPrimaryKey, YdbPrimaryKeyBuilder } from './primary-keys.js'
import {
	type YdbColumnFamily,
	YdbColumnFamilyBuilder,
	type YdbPartitioning,
	YdbPartitioningBuilder,
	type YdbTableOptions,
	YdbTableOptionsBuilder,
	type YdbTtl,
	YdbTtlBuilder,
} from './table-options.js'
import { YdbTable, type YdbTableExtraConfigValue, type YdbTableWithColumns } from './table.js'
import { type YdbUniqueConstraint, YdbUniqueConstraintBuilder } from './unique-constraint.js'
const drizzleTableSymbol = (Table as any).Symbol

export interface YdbTableRuntimeConfig {
	readonly name: string
	readonly columns: readonly YdbColumn[]
	readonly indexes: readonly YdbIndex[]
	readonly primaryKeys: readonly YdbPrimaryKey[]
	readonly uniqueConstraints: readonly YdbUniqueConstraint[]
	readonly tableOptions: readonly YdbTableOptions[]
	readonly partitioning: readonly YdbPartitioning[]
	readonly ttls: readonly YdbTtl[]
	readonly columnFamilies: readonly YdbColumnFamily[]
}

function normalizeExtraConfig(
	extraConfig: YdbTableExtraConfigValue[] | Record<string, YdbTableExtraConfigValue> | undefined
): YdbTableExtraConfigValue[] {
	if (!extraConfig) {
		return []
	}

	if (Array.isArray(extraConfig)) {
		return extraConfig.flat(1) as YdbTableExtraConfigValue[]
	}

	return Object.values(extraConfig)
}

export function getTableConfig(table: YdbTableWithColumns): YdbTableRuntimeConfig {
	const columns = Object.values((table as any)[YdbTable.Symbol.Columns] ?? {}) as YdbColumn[]
	const indexes: YdbIndex[] = []
	const primaryKeys: YdbPrimaryKey[] = []
	const uniqueConstraints: YdbUniqueConstraint[] = []
	const tableOptions: YdbTableOptions[] = []
	const partitioning: YdbPartitioning[] = []
	const ttls: YdbTtl[] = []
	const columnFamilies: YdbColumnFamily[] = []

	const extraConfigBuilder = (table as any)[YdbTable.Symbol.ExtraConfigBuilder] as
		| ((
				self: YdbTableWithColumns
		  ) => YdbTableExtraConfigValue[] | Record<string, YdbTableExtraConfigValue>)
		| undefined

	const extraValues = normalizeExtraConfig(extraConfigBuilder?.(table))
	for (const builder of extraValues) {
		if (is(builder, YdbIndexBuilder)) {
			indexes.push(builder.build(table))
		} else if (is(builder, YdbPrimaryKeyBuilder)) {
			primaryKeys.push(builder.build(table))
		} else if (is(builder, YdbTableOptionsBuilder)) {
			tableOptions.push(builder.build(table))
		} else if (is(builder, YdbPartitioningBuilder)) {
			partitioning.push(builder.build(table))
		} else if (is(builder, YdbTtlBuilder)) {
			ttls.push(builder.build(table))
		} else if (is(builder, YdbColumnFamilyBuilder)) {
			columnFamilies.push(builder.build(table))
		} else if (is(builder, YdbUniqueConstraintBuilder)) {
			uniqueConstraints.push(builder.build(table))
		}
	}

	for (const column of columns) {
		if (!column.isUnique) {
			continue
		}

		const hasTableLevelDuplicate = uniqueConstraints.some(
			(constraint) =>
				constraint.config.columns.length === 1 && constraint.config.columns[0] === column
		)

		if (hasTableLevelDuplicate) {
			continue
		}

		uniqueConstraints.push(
			new YdbUniqueConstraintBuilder(column.uniqueName, [column]).build(table)
		)
	}

	return {
		name: (table as any)[drizzleTableSymbol.Name] as string,
		columns,
		indexes,
		primaryKeys,
		uniqueConstraints,
		tableOptions,
		partitioning,
		ttls,
		columnFamilies,
	}
}
