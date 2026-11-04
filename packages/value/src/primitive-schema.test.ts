import { runInNewContext } from 'node:vm'
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import * as Ydb from '@ydbjs/api/value'
import { test } from 'vitest'
import { fromYdb } from './decode.js'
import {
	Bool,
	Bytes,
	Double,
	Float,
	Int16,
	Int32,
	Int64,
	Int8,
	Json,
	JsonDocument,
	Primitive,
	PrimitiveType,
	Text,
	Uint16,
	Uint32,
	Uint64,
	Uint8,
	Utf8,
	Uuid,
	UuidType,
	Yson,
} from './primitive.js'

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

test('rejects scalar coercion in public constructors and decoded values', (t) => {
	let cases = [
		[Bool, Ydb.Type_PrimitiveTypeId.BOOL, 'boolValue', 'false'],
		[Int32, Ydb.Type_PrimitiveTypeId.INT32, 'int32Value', '1'],
		[Int64, Ydb.Type_PrimitiveTypeId.INT64, 'int64Value', 1],
		[Float, Ydb.Type_PrimitiveTypeId.FLOAT, 'floatValue', '1.5'],
		[Double, Ydb.Type_PrimitiveTypeId.DOUBLE, 'doubleValue', '1.5'],
		[Text, Ydb.Type_PrimitiveTypeId.UTF8, 'textValue', 42],
		[Utf8, Ydb.Type_PrimitiveTypeId.UTF8, 'textValue', null],
		[Json, Ydb.Type_PrimitiveTypeId.JSON, 'textValue', { key: 1 }],
		[JsonDocument, Ydb.Type_PrimitiveTypeId.JSON_DOCUMENT, 'textValue', false],
		[Bytes, Ydb.Type_PrimitiveTypeId.STRING, 'bytesValue', [257, -1]],
		[Bytes, Ydb.Type_PrimitiveTypeId.STRING, 'bytesValue', new Uint16Array([257])],
		[Yson, Ydb.Type_PrimitiveTypeId.YSON, 'bytesValue', 'bytes'],
	] as const

	for (let [Input, id, field, input] of cases) {
		let wire = create(Ydb.ValueSchema)
		wire.value = { case: field, value: input } as never
		let type = new PrimitiveType(id).encode()

		t.expect(() => new Input(input as never)).toThrow(TypeError)
		t.expect(() => fromYdb(wire, type)).toThrow(TypeError)
	}
})

test('preserves floating point special values and rejects finite Float overflow', (t) => {
	for (let Input of [Float, Double]) {
		for (let input of [
			NaN,
			-Infinity,
			Infinity,
			-0,
			0,
			-(2 ** -149),
			2 ** -149,
			-3.4028234663852886e38,
			3.4028234663852886e38,
		]) {
			let value = new Input(input)
			let wire = fromBinary(Ydb.ValueSchema, toBinary(Ydb.ValueSchema, value.encode()))
			let decoded = fromYdb(wire, value.type.encode()) as Primitive

			t.expect(value.value).toBe(input)
			t.expect(decoded.value).toBe(input)
		}
	}

	for (let input of [-Number.MAX_VALUE, Number.MAX_VALUE]) {
		let wire = create(Ydb.ValueSchema)
		wire.value = { case: 'floatValue', value: input }
		let type = new PrimitiveType(Ydb.Type_PrimitiveTypeId.FLOAT).encode()

		t.expect(() => new Float(input)).toThrow(RangeError)
		t.expect(() => fromYdb(wire, type)).toThrow(RangeError)
		t.expect(new Double(input).value).toBe(input)
	}

	let value = new Float(3.4028235e38)
	let wire = fromBinary(Ydb.ValueSchema, toBinary(Ydb.ValueSchema, value.encode()))
	t.expect(wire.value.value).toBe(3.4028234663852886e38)
})

test('preserves Uint8Array and Buffer bytes across realms and binary encoding', (t) => {
	let inputs = [
		new Uint8Array([0, 127, 255]),
		Buffer.from([0, 127, 255]),
		runInNewContext('new Uint8Array([0, 127, 255])') as Uint8Array,
	]

	for (let Input of [Bytes, Yson]) {
		for (let input of inputs) {
			let value = new Input(input)
			let wire = fromBinary(Ydb.ValueSchema, toBinary(Ydb.ValueSchema, value.encode()))
			let decoded = fromYdb(wire, value.type.encode()) as Primitive

			t.expect(Array.from(value.value as Uint8Array)).toEqual([0, 127, 255])
			t.expect(wire.value.case).toBe('bytesValue')
			t.expect(Array.from(decoded.value as Uint8Array)).toEqual([0, 127, 255])
		}
	}
})

test('rejects UUID words outside the unsigned 64-bit domain before encoding or projection', (t) => {
	let cases = [
		['low128', 1, TypeError],
		['low128', -1n, RangeError],
		['low128', 2n ** 64n, RangeError],
		['high128', 1, TypeError],
		['high128', null, TypeError],
		['high128', -1n, RangeError],
		['high128', 2n ** 64n, RangeError],
	] as const
	let type = new UuidType()

	for (let [field, input, error] of cases) {
		let wire = create(Ydb.ValueSchema, { value: { case: 'low128', value: 0n } })
		if (field === 'low128') wire.value = { case: field, value: input as never }
		else wire.high128 = input as never

		t.expect(() => new Primitive(wire, type)).toThrow(error)
		t.expect(() => fromYdb(wire, type.encode())).toThrow(error)
	}

	for (let word of [0n, 2n ** 64n - 1n]) {
		let value = new Primitive({ value: { case: 'low128', value: word }, high128: word }, type)
		let wire = fromBinary(Ydb.ValueSchema, toBinary(Ydb.ValueSchema, value.encode()))

		t.expect(wire.value.value).toBe(word)
		t.expect(wire.high128).toBe(word)
	}

	let value = new Primitive({ value: { case: 'low128', value: 0n } }, type)
	t.expect(value.high128).toBe(0n)
})

test('rejects out-of-range integer values before they can be encoded under a narrower type', (t) => {
	let cases = [
		[Int8, Ydb.Type_PrimitiveTypeId.INT8, 'int32Value', -128, 127],
		[Uint8, Ydb.Type_PrimitiveTypeId.UINT8, 'uint32Value', 0, 255],
		[Int16, Ydb.Type_PrimitiveTypeId.INT16, 'int32Value', -32768, 32767],
		[Uint16, Ydb.Type_PrimitiveTypeId.UINT16, 'uint32Value', 0, 65535],
		[Int32, Ydb.Type_PrimitiveTypeId.INT32, 'int32Value', -2147483648, 2147483647],
		[Uint32, Ydb.Type_PrimitiveTypeId.UINT32, 'uint32Value', 0, 4294967295],
	] as const

	for (let [Input, id, field, min, max] of cases) {
		for (let input of [min, max]) {
			let value = new Input(input)

			t.expect(value.type.id).toBe(id)
			t.expect(
				fromBinary(Ydb.ValueSchema, toBinary(Ydb.ValueSchema, value.encode())).value
			).toEqual({ case: field, value: input })
		}

		for (let input of [min - 1, max + 1, 0.5, NaN, Infinity]) {
			t.expect(() => new Input(input)).toThrow(/integer range/)
		}
	}

	for (let [Input, id, field, min, max] of [
		[Int64, Ydb.Type_PrimitiveTypeId.INT64, 'int64Value', -(2n ** 63n), 2n ** 63n - 1n],
		[Uint64, Ydb.Type_PrimitiveTypeId.UINT64, 'uint64Value', 0n, 2n ** 64n - 1n],
	] as const) {
		for (let input of [min, max]) {
			let value = new Input(input)

			t.expect(value.type.id).toBe(id)
			t.expect(
				fromBinary(Ydb.ValueSchema, toBinary(Ydb.ValueSchema, value.encode())).value
			).toEqual({ case: field, value: input })
		}

		for (let input of [min - 1n, max + 1n]) {
			t.expect(() => new Input(input)).toThrow(/integer range/)
		}
	}
})
