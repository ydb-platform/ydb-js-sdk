import { entityKind } from 'drizzle-orm/entity'
import { SelectionProxyHandler } from 'drizzle-orm/selection-proxy'
import type { SQL, SQLWrapper } from 'drizzle-orm/sql/sql'
import { type Subquery, WithSubquery } from 'drizzle-orm/subquery'
import { YdbDialect } from '../../ydb/dialect.js'
import { YdbSelectBuilder } from './select.builder.js'
import type { SelectFields } from './select.types.js'

type YdbSelectableQuery =
	| SQL
	| {
			getSQL(): SQL
			getSelectedFields(): SelectFields | undefined
	  }

export class YdbQueryBuilder {
	static readonly [entityKind] = 'YdbQueryBuilder'

	private dialect: YdbDialect | undefined

	constructor(dialect?: YdbDialect) {
		this.dialect = dialect
	}

	$with<TAlias extends string>(alias: TAlias) {
		return {
			as: (query: YdbSelectableQuery | ((qb: YdbQueryBuilder) => YdbSelectableQuery)) => {
				const resolved = typeof query === 'function' ? query(this) : query
				const selectedFields =
					'getSelectedFields' in resolved ? (resolved.getSelectedFields() ?? {}) : {}

				return new Proxy(
					new WithSubquery(resolved.getSQL(), selectedFields, alias, true),
					new SelectionProxyHandler({
						alias,
						sqlAliasedBehavior: 'alias',
						sqlBehavior: 'error',
					})
				)
			},
		}
	}

	with(...queries: Subquery[]) {
		const select = <TFields extends SelectFields | undefined = undefined>(fields?: TFields) =>
			new YdbSelectBuilder(undefined, this.getDialect(), fields as any, {}, queries)

		const selectDistinct = <TFields extends SelectFields | undefined = undefined>(
			fields?: TFields
		) =>
			new YdbSelectBuilder(
				undefined,
				this.getDialect(),
				fields as any,
				{ distinct: true },
				queries
			)

		const selectDistinctOn = <TFields extends SelectFields | undefined = undefined>(
			on: SQLWrapper | SQLWrapper[],
			fields?: TFields
		) =>
			new YdbSelectBuilder(
				undefined,
				this.getDialect(),
				fields as any,
				{
					distinctOn: Array.isArray(on) ? on : [on],
				},
				queries
			)

		return { select, selectDistinct, selectDistinctOn }
	}

	select<TFields extends SelectFields | undefined = undefined>(fields?: TFields) {
		return new YdbSelectBuilder(undefined, this.getDialect(), fields as any)
	}

	selectDistinct<TFields extends SelectFields | undefined = undefined>(fields?: TFields) {
		return new YdbSelectBuilder(undefined, this.getDialect(), fields as any, { distinct: true })
	}

	selectDistinctOn<TFields extends SelectFields | undefined = undefined>(
		on: SQLWrapper | SQLWrapper[],
		fields?: TFields
	) {
		return new YdbSelectBuilder(undefined, this.getDialect(), fields as any, {
			distinctOn: Array.isArray(on) ? on : [on],
		})
	}

	private getDialect(): YdbDialect {
		if (!this.dialect) {
			this.dialect = new YdbDialect()
		}

		return this.dialect
	}
}
