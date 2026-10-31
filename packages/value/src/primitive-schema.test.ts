import { fromBinary, toBinary } from '@bufbuild/protobuf'
import * as Ydb from '@ydbjs/api/value'
import { test } from 'vitest'
import { Primitive, PrimitiveType, Uuid, UuidType } from './primitive.js'

test('preserves both UUID halves in primitive state and binary encoding', (t) => {
	let original = new Uuid('00112233-4455-6677-8899-aabbccddeeff')
	let input = fromBinary(Ydb.ValueSchema, toBinary(Ydb.ValueSchema, original.encode()))
	let value = new Primitive(input, new UuidType())
	let output = fromBinary(Ydb.ValueSchema, toBinary(Ydb.ValueSchema, value.encode()))

	t.expect(value.value).toBe(original.low128)
	t.expect(value.high128).toBe(original.high128)
	t.expect(output).toEqual(input)
	t.expect(value.type.encode()).toEqual(original.type.encode())
})

test('rejects primitive payloads that contradict their explicit type', (t) => {
	t.expect(
		() =>
			new Primitive(
				{ value: { case: 'textValue', value: 'abc' } },
				new PrimitiveType(Ydb.Type_PrimitiveTypeId.INT32)
			)
	).toThrow('requires int32Value')
	t.expect(
		() =>
			new Primitive(
				{ value: { case: 'int32Value', value: 1 } },
				new PrimitiveType(Ydb.Type_PrimitiveTypeId.INTERVAL)
			)
	).toThrow('requires int64Value')
})
