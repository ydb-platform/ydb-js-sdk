import { haveSameKeys } from 'drizzle-orm/utils'
import type { YdbSetOperatorConfig, YdbSetOperatorSource } from '../../ydb/dialect.types.js'
import type { YdbSelectBuilder } from './select.builder.js'

function createTopLevelSetOperator(type: 'union' | 'intersect' | 'except', isAll: boolean) {
	return (
		leftSelect: YdbSelectBuilder,
		rightSelect: YdbSetOperatorSource,
		...restSelects: YdbSetOperatorSource[]
	) => {
		let setOperators = [rightSelect, ...restSelects].map((select) => {
			if (!haveSameKeys(leftSelect.getSelectedFields(), select.getSelectedFields())) {
				throw new Error(
					'Set operator error (union / intersect / except): selected fields are not the same or are in a different order'
				)
			}

			return {
				type,
				isAll,
				rightSelect: select,
			} satisfies YdbSetOperatorConfig
		})

		return leftSelect.addSetOperators(setOperators)
	}
}

export let union = createTopLevelSetOperator('union', false)
export let unionAll = createTopLevelSetOperator('union', true)
export let intersect = createTopLevelSetOperator('intersect', false)
export let except = createTopLevelSetOperator('except', false)

export function getSetOperatorHelpers() {
	return { union, unionAll, intersect, except }
}
