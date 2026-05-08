import { YdbColumn, YdbColumnBuilder } from './common.js'

export class YdbTextBuilder extends YdbColumnBuilder {
	constructor(name: string) {
		super(name, 'string', 'YdbText')
	}

	override build<TTable>(table: TTable): YdbText {
		return new YdbText(table as any, this.config)
	}
}

export class YdbText extends YdbColumn {
	override getSQLType(): string {
		return 'Utf8'
	}
}

export function text(name?: string): YdbTextBuilder
export function text(a?: string): YdbTextBuilder {
	return new YdbTextBuilder(a ?? '')
}
