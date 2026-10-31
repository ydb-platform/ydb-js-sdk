import { equals } from '@bufbuild/protobuf'
import * as Ydb from '@ydbjs/api/value'
import { expect, test } from 'vitest'

import { DecimalType } from './decimal.js'
import { DictType } from './dict.js'
import { EmptyType } from './empty.js'
import { ListType } from './list.js'
import { NullType } from './null.js'
import { OptionalType } from './optional.js'
import { Int32Type, TextType } from './primitive.js'
import { StructType } from './struct.js'
import { TupleType } from './tuple.js'
import { assertType } from './type-check.js'
import { type Type, TypeKind } from './type.js'

test('schema compatibility agrees with protobuf equality for nested types', () => {
	let scalar = [
		new Int32Type(),
		new TextType(),
		new NullType(),
		new DecimalType(22, 9),
		new DecimalType(22, 8),
	]
	let types: Type[] = [
		...scalar,
		new EmptyType(TypeKind.EMPTY_LIST),
		new EmptyType(TypeKind.EMPTY_DICT),
	]
	for (let item of scalar) {
		types.push(
			new OptionalType(item),
			new ListType(item),
			new StructType(['a'], [item]),
			new StructType(['b'], [item])
		)
		for (let other of scalar)
			types.push(new DictType(item, other), new TupleType([item, other]))
	}
	types.push(new OptionalType(new ListType(new OptionalType(new Int32Type()))))
	for (let left of types) {
		for (let right of types) {
			let matches = true
			try {
				assertType(left, right, 'Value')
			} catch {
				matches = false
			}
			expect(matches).toBe(equals(Ydb.TypeSchema, left.encode(), right.encode()))
		}
	}
})
