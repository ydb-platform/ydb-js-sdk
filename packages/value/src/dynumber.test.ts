import { fromBinary, toBinary } from '@bufbuild/protobuf'
import * as Ydb from '@ydbjs/api/value'
import { expect, test } from 'vitest'
import { DyNumber } from './primitive.js'
import type { Value } from './value.js'

function binary(value: Value): Ydb.Value {
	return fromBinary(Ydb.ValueSchema, toBinary(Ydb.ValueSchema, value.encode()))
}

test('DyNumber construction preserves the decimal text instead of coercing it to number', () => {
	let text = '123456789012345678901234567890.12345678'
	let value = new DyNumber(text)
	expect(value.type.encode().type).toEqual({
		case: 'typeId',
		value: Ydb.Type_PrimitiveTypeId.DYNUMBER,
	})
	expect(binary(value).value).toEqual({ case: 'textValue', value: text })
})
