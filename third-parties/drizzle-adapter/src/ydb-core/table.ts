import type { MakeColumnConfig } from 'drizzle-orm/column-builder'
import { entityKind } from 'drizzle-orm/entity'
import {
	Table,
	type TableConfig as TableConfigBase,
	type UpdateTableConfig,
} from 'drizzle-orm/table'
import type { Assume, Simplify } from 'drizzle-orm/utils'
import type { YdbColumn, YdbColumnBuilderBase } from './columns/common.js'
import type { YdbColumnBuilders } from './columns/all.js'
import type { YdbIndexBuilder } from './indexes.js'
import type { YdbPrimaryKeyBuilder } from './primary-keys.js'
import type {
	YdbColumnFamilyBuilder,
	YdbPartitioningBuilder,
	YdbTableOptionsBuilder,
	YdbTtlBuilder,
} from './table-options.js'
import type { YdbUniqueConstraintBuilder } from './unique-constraint.js'
import { getYdbColumnBuilders } from './columns/all.js'

export type TableConfig = TableConfigBase<YdbColumn>
const drizzleTableSymbol = (Table as any).Symbol

export class YdbTable<T extends TableConfig = TableConfig> extends Table<T> {
	static override readonly [entityKind] = 'YdbTable'
	static readonly Symbol = Object.assign({}, drizzleTableSymbol)
}

export type AnyYdbTable<TPartial extends Partial<TableConfig> = {}> = YdbTable<
	UpdateTableConfig<TableConfig, TPartial>
>

export type YdbBuildColumn<
	TTableName extends string,
	TBuilder extends YdbColumnBuilderBase,
> = YdbColumn<
	MakeColumnConfig<TBuilder['_'], TTableName>,
	{},
	Simplify<
		Omit<TBuilder['_'], keyof MakeColumnConfig<TBuilder['_'], TTableName> | 'brand' | 'dialect'>
	>
>

export type YdbBuildColumns<
	TTableName extends string,
	TColumnsMap extends Record<string, YdbColumnBuilderBase>,
> = {
	[Key in keyof TColumnsMap]: YdbBuildColumn<
		TTableName,
		{
			_: Omit<TColumnsMap[Key]['_'], 'name'> & {
				name: TColumnsMap[Key]['_']['name'] extends ''
					? Assume<Key, string>
					: TColumnsMap[Key]['_']['name']
			}
		}
	>
}

export type YdbTableWithColumns<T extends TableConfig = TableConfig> = YdbTable<T> & {
	[Key in keyof T['columns']]: T['columns'][Key]
} & Record<string, YdbColumn>

export type YdbColumnsMap = Record<string, YdbColumnBuilderBase>
export type YdbColumnsFactory<TColumnsMap extends YdbColumnsMap = YdbColumnsMap> = (
	builders: YdbColumnBuilders
) => TColumnsMap
export type YdbColumnsInput<TColumnsMap extends YdbColumnsMap = YdbColumnsMap> =
	| TColumnsMap
	| YdbColumnsFactory<TColumnsMap>
export type YdbTableExtraConfigValue =
	| YdbIndexBuilder
	| YdbPrimaryKeyBuilder
	| YdbTableOptionsBuilder
	| YdbPartitioningBuilder
	| YdbTtlBuilder
	| YdbColumnFamilyBuilder
	| YdbUniqueConstraintBuilder
export type YdbTableExtraConfig = Record<string, YdbTableExtraConfigValue>

function ydbTableBase<
	TTableName extends string,
	TSchemaName extends string | undefined,
	TColumnsMap extends YdbColumnsMap,
>(
	name: TTableName,
	columns: TColumnsMap | ((builders: YdbColumnBuilders) => TColumnsMap),
	extraConfig:
		| ((
				self: YdbBuildColumns<TTableName, TColumnsMap>
		  ) => YdbTableExtraConfigValue[] | YdbTableExtraConfig)
		| undefined,
	schema?: TSchemaName,
	baseName = name
): YdbTableWithColumns<{
	name: TTableName
	schema: TSchemaName
	columns: YdbBuildColumns<TTableName, TColumnsMap>
	dialect: 'ydb'
}> {
	const rawTable = new YdbTable(name, schema, baseName)
	const parsedColumns = (
		typeof columns === 'function' ? columns(getYdbColumnBuilders()) : columns
	) as TColumnsMap
	const builtColumns = Object.fromEntries(
		Object.entries(parsedColumns).map(([key, builder]) => {
			;(builder as any).setName?.(key)
			const column = (builder as any).build?.(rawTable)
			return [key, column]
		})
	) as Record<string, YdbColumn>

	const table = Object.assign(rawTable, builtColumns)
	;(table as any)[drizzleTableSymbol.Columns] = builtColumns
	;(table as any)[drizzleTableSymbol.ExtraConfigColumns] = builtColumns

	if (extraConfig) {
		;(table as any)[drizzleTableSymbol.ExtraConfigBuilder] = extraConfig
	}

	return table as YdbTableWithColumns<{
		name: TTableName
		schema: TSchemaName
		columns: YdbBuildColumns<TTableName, TColumnsMap>
		dialect: 'ydb'
	}>
}

export interface YdbTableFn<TSchemaName extends string | undefined = undefined> {
	<TTableName extends string, TColumnsMap extends YdbColumnsMap>(
		name: TTableName,
		columns: TColumnsMap,
		extraConfig?: (self: YdbBuildColumns<TTableName, TColumnsMap>) => YdbTableExtraConfigValue[]
	): YdbTableWithColumns<{
		name: TTableName
		schema: TSchemaName
		columns: YdbBuildColumns<TTableName, TColumnsMap>
		dialect: 'ydb'
	}>
	<TTableName extends string, TColumnsMap extends YdbColumnsMap>(
		name: TTableName,
		columns: (columnTypes: YdbColumnBuilders) => TColumnsMap,
		extraConfig?: (self: YdbBuildColumns<TTableName, TColumnsMap>) => YdbTableExtraConfigValue[]
	): YdbTableWithColumns<{
		name: TTableName
		schema: TSchemaName
		columns: YdbBuildColumns<TTableName, TColumnsMap>
		dialect: 'ydb'
	}>
	<TTableName extends string, TColumnsMap extends YdbColumnsMap>(
		name: TTableName,
		columns: TColumnsMap,
		extraConfig: (self: YdbBuildColumns<TTableName, TColumnsMap>) => YdbTableExtraConfig
	): YdbTableWithColumns<{
		name: TTableName
		schema: TSchemaName
		columns: YdbBuildColumns<TTableName, TColumnsMap>
		dialect: 'ydb'
	}>
	<TTableName extends string, TColumnsMap extends YdbColumnsMap>(
		name: TTableName,
		columns: (columnTypes: YdbColumnBuilders) => TColumnsMap,
		extraConfig: (self: YdbBuildColumns<TTableName, TColumnsMap>) => YdbTableExtraConfig
	): YdbTableWithColumns<{
		name: TTableName
		schema: TSchemaName
		columns: YdbBuildColumns<TTableName, TColumnsMap>
		dialect: 'ydb'
	}>
}

export const ydbTable: YdbTableFn = ((
	name: string,
	columns: YdbColumnsInput,
	extraConfig?: unknown
) => ydbTableBase(name as any, columns as any, extraConfig as any)) as any

export function ydbTableCreator(customizeTableName: (name: string) => string): YdbTableFn {
	return ((
		name: string,
		columns: YdbColumnsInput,
		extraConfig?: (
			self: Record<string, YdbColumn>
		) => YdbTableExtraConfigValue[] | YdbTableExtraConfig
	) =>
		ydbTableBase(
			customizeTableName(name),
			columns as any,
			extraConfig as any,
			undefined,
			name
		)) as YdbTableFn
}
