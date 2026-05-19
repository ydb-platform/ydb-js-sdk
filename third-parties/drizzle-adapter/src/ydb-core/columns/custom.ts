import type {
	ColumnBuilderBaseConfig,
	ColumnBuilderRuntimeConfig,
	MakeColumnConfig,
} from 'drizzle-orm/column-builder'
import type { ColumnBaseConfig } from 'drizzle-orm/column'
import { entityKind } from 'drizzle-orm/entity'
import type { SQL } from 'drizzle-orm/sql/sql'
import type { Table } from 'drizzle-orm/table'
import { type Equal } from 'drizzle-orm/utils'
import { YdbColumn, YdbColumnBuilder } from './common.js'

function getColumnNameAndConfig<TConfig extends Record<string, any> | undefined>(
	a: string | TConfig | undefined,
	b: TConfig | undefined
) {
	return {
		name: typeof a === 'string' && a.length > 0 ? a : '',
		config: typeof a === 'object' ? a : b,
	}
}

export type ConvertCustomConfig<TName extends string, T extends Partial<CustomTypeValues>> = {
	name: TName
	dataType: 'custom'
	columnType: 'YdbCustomColumn'
	data: T['data']
	driverParam: T['driverData']
	enumValues: undefined
} & (T['notNull'] extends true ? { notNull: true } : {}) &
	(T['default'] extends true ? { hasDefault: true } : {})

export interface CustomTypeValues {
	data: unknown
	driverData?: unknown
	config?: Record<string, any>
	configRequired?: boolean
	notNull?: boolean
	default?: boolean
}

export interface CustomTypeParams<T extends CustomTypeValues> {
	dataType: (
		config: T['config'] | (Equal<T['configRequired'], true> extends true ? never : undefined)
	) => string
	toDriver?: (value: T['data']) => T['driverData'] | SQL
	fromDriver?: (value: T['driverData']) => T['data']
}

export class YdbCustomColumnBuilder<
	T extends ColumnBuilderBaseConfig<'custom', 'YdbCustomColumn'>,
> extends YdbColumnBuilder<
	T,
	{
		fieldConfig: CustomTypeValues['config']
		customTypeParams: CustomTypeParams<any>
	},
	{
		ydbColumnBuilderBrand: 'YdbCustomColumnBuilderBrand'
	}
> {
	static override readonly [entityKind]: string = 'YdbCustomColumnBuilder'

	constructor(
		name: T['name'],
		fieldConfig: CustomTypeValues['config'],
		customTypeParams: CustomTypeParams<any>
	) {
		super(name, 'custom', 'YdbCustomColumn')
		this.config.fieldConfig = fieldConfig
		this.config.customTypeParams = customTypeParams
	}

	override build<TTable extends Table>(
		table: TTable
	): YdbCustomColumn<MakeColumnConfig<T, TTable['_']['name']>> {
		return new YdbCustomColumn<MakeColumnConfig<T, TTable['_']['name']>>(
			table,
			this.config as ColumnBuilderRuntimeConfig<any, any>
		)
	}
}

export class YdbCustomColumn<
	T extends ColumnBaseConfig<'custom', 'YdbCustomColumn'>,
> extends YdbColumn<T> {
	static override readonly [entityKind]: string = 'YdbCustomColumn'

	private readonly sqlName: string
	private readonly mapTo: ((value: T['data']) => T['driverParam'] | SQL) | undefined
	private readonly mapFrom: ((value: T['driverParam']) => T['data']) | undefined

	constructor(table: Table, config: YdbCustomColumnBuilder<any>['config']) {
		super(table, config)
		this.sqlName = config.customTypeParams.dataType(config.fieldConfig)
		this.mapTo = config.customTypeParams.toDriver
		this.mapFrom = config.customTypeParams.fromDriver
	}

	override getSQLType(): string {
		return this.sqlName
	}

	override mapFromDriverValue(value: T['driverParam']): T['data'] {
		return typeof this.mapFrom === 'function' ? this.mapFrom(value) : (value as T['data'])
	}

	override mapToDriverValue(value: T['data']): T['driverParam'] {
		return typeof this.mapTo === 'function'
			? (this.mapTo(value) as T['driverParam'])
			: (value as T['driverParam'])
	}
}

export function customType<T extends CustomTypeValues = CustomTypeValues>(
	customTypeParams: CustomTypeParams<T>
): Equal<T['configRequired'], true> extends true
	? {
			<TConfig extends Record<string, any> & T['config']>(
				fieldConfig: TConfig
			): YdbCustomColumnBuilder<ConvertCustomConfig<'', T>>
			<TName extends string>(
				dbName: TName,
				fieldConfig: T['config']
			): YdbCustomColumnBuilder<ConvertCustomConfig<TName, T>>
		}
	: {
			(): YdbCustomColumnBuilder<ConvertCustomConfig<'', T>>
			<TConfig extends Record<string, any> & T['config']>(
				fieldConfig?: TConfig
			): YdbCustomColumnBuilder<ConvertCustomConfig<'', T>>
			<TName extends string>(
				dbName: TName,
				fieldConfig?: T['config']
			): YdbCustomColumnBuilder<ConvertCustomConfig<TName, T>>
		} {
	return ((a?: string | T['config'], b?: T['config']) => {
		const { name, config } = getColumnNameAndConfig<T['config']>(a, b)
		return new YdbCustomColumnBuilder(name as any, config, customTypeParams)
	}) as any
}
