import { entityKind } from 'drizzle-orm/entity'
import { SQL, type SQLWrapper, sql as yql } from 'drizzle-orm/sql/sql'
import type { YdbSession } from '../session.js'

export interface YdbCountBuilderParams {
	source: SQLWrapper
	filters?: SQL | undefined
	session: Pick<YdbSession, 'count'>
}

export class YdbCountBuilder extends SQL<number> {
	static override readonly [entityKind] = 'YdbCountBuilder'
	readonly [Symbol.toStringTag] = 'YdbCountBuilder'

	private readonly session: Pick<YdbSession, 'count'>
	private readonly countSql: SQL<number>

	constructor(params: YdbCountBuilderParams) {
		const embeddedCount = YdbCountBuilder.buildEmbeddedCount(params.source, params.filters)
		super(embeddedCount.queryChunks)
		this.session = params.session
		this.mapWith(Number)
		this.countSql = YdbCountBuilder.buildCount(params.source, params.filters)
	}

	static buildEmbeddedCount(source: SQLWrapper, filters?: SQL): SQL<number> {
		return yql`(select count(*) from ${source}${yql.raw(' where ').if(filters)}${filters})`
	}

	static buildCount(source: SQLWrapper, filters?: SQL): SQL<number> {
		return yql`select count(*) as count from ${source}${yql.raw(' where ').if(filters)}${filters}`
	}

	then<TResult1 = number, TResult2 = never>(
		onfulfilled?: ((value: number) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
	): Promise<TResult1 | TResult2> {
		return Promise.resolve(this.session.count(this.countSql)).then(onfulfilled, onrejected)
	}

	catch<TResult = never>(
		onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
	): Promise<number | TResult> {
		return this.then(undefined, onrejected)
	}

	finally(onfinally?: (() => void) | null): Promise<number> {
		return this.then(
			(value) => {
				onfinally?.()
				return value
			},
			(reason) => {
				onfinally?.()
				throw reason
			}
		)
	}
}
