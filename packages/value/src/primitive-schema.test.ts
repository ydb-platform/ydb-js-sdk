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

test('rejects out-of-range integer values before they can be encoded under a narrower type', (t) => {
	let cases = [
		[Ydb.Type_PrimitiveTypeId.INT8, 'int32Value', -128, 127],
		[Ydb.Type_PrimitiveTypeId.UINT8, 'uint32Value', 0, 255],
		[Ydb.Type_PrimitiveTypeId.INT16, 'int32Value', -32768, 32767],
		[Ydb.Type_PrimitiveTypeId.UINT16, 'uint32Value', 0, 65535],
		[Ydb.Type_PrimitiveTypeId.INT32, 'int32Value', -2147483648, 2147483647],
		[Ydb.Type_PrimitiveTypeId.UINT32, 'uint32Value', 0, 4294967295],
	] as const
	for (let [id, field, min, max] of cases) {
		let type = new PrimitiveType(id)
		for (let input of [min, max]) {
			let value = new Primitive({ value: { case: field, value: input } }, type)
			t.expect(
				fromBinary(Ydb.ValueSchema, toBinary(Ydb.ValueSchema, value.encode())).value.value
			).toBe(input)
		}
		for (let input of [min - 1, max + 1, 0.5, NaN, Infinity]) {
			t.expect(() => new Primitive({ value: { case: field, value: input } }, type)).toThrow(
				/integer range/
			)
		}
	}
	for (let [id, field, min, max] of [
		[Ydb.Type_PrimitiveTypeId.INT64, 'int64Value', -(2n ** 63n), 2n ** 63n - 1n],
		[Ydb.Type_PrimitiveTypeId.UINT64, 'uint64Value', 0n, 2n ** 64n - 1n],
	] as const) {
		let type = new PrimitiveType(id)
		for (let input of [min, max]) {
			let value = new Primitive({ value: { case: field, value: input } }, type)
			t.expect(
				fromBinary(Ydb.ValueSchema, toBinary(Ydb.ValueSchema, value.encode())).value.value
			).toBe(input)
		}
		for (let input of [min - 1n, max + 1n]) {
			t.expect(() => new Primitive({ value: { case: field, value: input } }, type)).toThrow(
				/integer range/
			)
		}
	}
})
