import { equals } from '@bufbuild/protobuf'
import * as Ydb from '@ydbjs/api/value'

import { typeToString } from './print.js'
import type { Type } from './type.js'

function sameType(left: Ydb.Type, right: Ydb.Type): boolean {
	if (left === right) return true
	if (left.type.case !== right.type.case) return false
	let a = left.type
	switch (a.case) {
		case 'typeId':
		case 'nullType':
		case 'emptyListType':
		case 'emptyDictType':
			return a.value === right.type.value
		case 'optionalType':
		case 'listType':
			return sameType(a.value.item!, (right.type.value as typeof a.value).item!)
		case 'dictType': {
			let b = right.type.value as typeof a.value
			return sameType(a.value.key!, b.key!) && sameType(a.value.payload!, b.payload!)
		}
		case 'tupleType': {
			let b = right.type.value as typeof a.value
			return (
				a.value.elements.length === b.elements.length &&
				a.value.elements.every((item, i) => sameType(item, b.elements[i]!))
			)
		}
		case 'structType': {
			let b = right.type.value as typeof a.value
			return (
				a.value.members.length === b.members.length &&
				a.value.members.every(
					(item, i) =>
						item.name === b.members[i]!.name &&
						sameType(item.type!, b.members[i]!.type!)
				)
			)
		}
		case 'decimalType': {
			let b = right.type.value as typeof a.value
			return a.value.precision === b.precision && a.value.scale === b.scale
		}
		default:
			return equals(Ydb.TypeSchema, left, right)
	}
}

export function assertType(actual: Type, expected: Type, location: string): void {
	if (!actual || typeof actual.encode !== 'function') {
		throw new TypeError(`${location}: expected a typed Value`)
	}
	if (actual !== expected && !sameType(actual.encode(), expected.encode())) {
		throw new TypeError(
			`${location}: expected type ${typeToString(expected)}, got ${typeToString(actual)}`
		)
	}
}
