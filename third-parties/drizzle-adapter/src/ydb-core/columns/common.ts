import type {
	ColumnBuilderBase,
	ColumnBuilderBaseConfig,
	ColumnBuilderExtraConfig,
	ColumnBuilderRuntimeConfig,
	ColumnDataType,
} from 'drizzle-orm/column-builder'
import { ColumnBuilder } from 'drizzle-orm/column-builder'
import type { ColumnBaseConfig, ColumnRuntimeConfig } from 'drizzle-orm/column'
import { Column } from 'drizzle-orm/column'
import { entityKind } from 'drizzle-orm/entity'
import type { SQL } from 'drizzle-orm/sql/sql'
import type { Table } from 'drizzle-orm/table'
import type { Update } from 'drizzle-orm/utils'
import { uniqueKeyName } from '../unique-constraint.js'

export interface YdbColumnBuilderBase<
	T extends ColumnBuilderBaseConfig<ColumnDataType, string> = ColumnBuilderBaseConfig<
		ColumnDataType,
		string
	>,
	TTypeConfig extends object = object,
> extends ColumnBuilderBase<T, TTypeConfig & { dialect: 'ydb' }> {}

export class YdbColumnBuilder<
	T extends ColumnBuilderBaseConfig<ColumnDataType, string> = ColumnBuilderBaseConfig<
		ColumnDataType,
		string
	>,
	TRuntimeConfig extends object = object,
	TTypeConfig extends object = object,
	TExtraConfig extends ColumnBuilderExtraConfig = ColumnBuilderExtraConfig,
>
	extends ColumnBuilder<T, TRuntimeConfig, TTypeConfig & { dialect: 'ydb' }, TExtraConfig>
	implements YdbColumnBuilderBase<T, TTypeConfig>
{
	static override readonly [entityKind]: string = 'YdbColumnBuilder'

	unique(name?: string): this {
		this.config.isUnique = true
		this.config.uniqueName = name
		return this
	}

	override generatedAlwaysAs(
		_as: SQL | this['_']['data'] | (() => SQL),
		_config?: { mode?: 'virtual' | 'stored' }
	): any {
		throw new Error('YDB generatedAlwaysAs() is not supported')
	}

	build<TTable extends Table>(table: TTable): YdbColumn {
		return new YdbColumn(table, this.config as ColumnBuilderRuntimeConfig<any, any>)
	}
}

export class YdbColumn<
	T extends ColumnBaseConfig<ColumnDataType, string> = ColumnBaseConfig<ColumnDataType, string>,
	TRuntimeConfig extends object = object,
	TTypeConfig extends object = object,
> extends Column<T, TRuntimeConfig, TTypeConfig & { dialect: 'ydb' }> {
	static override readonly [entityKind]: string = 'YdbColumn'

	constructor(table: Table, config: ColumnRuntimeConfig<T['data'], TRuntimeConfig>) {
		if (config.isUnique && !config.uniqueName) {
			config.uniqueName = uniqueKeyName(table as any, [config.name])
		}

		super(table, config)
	}

	override getSQLType(): string {
		return 'unknown'
	}

	override mapFromDriverValue(value: T['driverParam']): T['data'] {
		return super.mapFromDriverValue(value) as T['data']
	}

	override mapToDriverValue(value: T['data']): T['driverParam'] {
		return super.mapToDriverValue(value) as T['driverParam']
	}
}

export type AnyYdbColumn<TPartial extends Partial<ColumnBaseConfig<ColumnDataType, string>> = {}> =
	YdbColumn<Required<Update<ColumnBaseConfig<ColumnDataType, string>, TPartial>>>
