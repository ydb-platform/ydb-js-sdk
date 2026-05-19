import { YdbColumn, YdbColumnBuilder } from './common.js'

export interface YdbIntegerConfig {
	mode?: 'number'
}

export class YdbIntegerBuilder extends YdbColumnBuilder {
	constructor(name: string) {
		super(name, 'number', 'YdbInteger')
	}

	override build<TTable>(table: TTable): YdbInteger {
		return new YdbInteger(table as any, this.config)
	}
}

export class YdbInteger extends YdbColumn {
	override getSQLType(): string {
		return 'Int32'
	}
}

export function integer(name?: string): YdbIntegerBuilder
export function integer(name?: string, _config?: YdbIntegerConfig): YdbIntegerBuilder
export function integer(a?: string, _b?: YdbIntegerConfig): YdbIntegerBuilder {
	return new YdbIntegerBuilder(a ?? '')
}

export const int = integer
