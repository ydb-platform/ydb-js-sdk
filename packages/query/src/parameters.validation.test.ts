import { runInNewContext } from 'node:vm'
import { create } from '@bufbuild/protobuf'
import { WireType } from '@bufbuild/protobuf/wire'
import { TypeSchema } from '@ydbjs/api/value'
import { TypeKind } from '@ydbjs/value'
import { List } from '@ydbjs/value/list'
import { Bool, Bytes, Double, Int32, Int64, Text } from '@ydbjs/value/primitive'
import { expect, test } from 'vitest'

import { encodeParameters } from './parameters.ts'

test('parameter validation borrows frozen wire messages and foreign-realm byte views', () => {
	let bytes = runInNewContext('Uint8Array.of(0, 1, 2, 3).subarray(1, 3)') as Uint8Array
	let input = new Bytes(bytes)
	let type = input.type.encode()
	let wire = input.encode()
	let field = { no: 1000, wireType: WireType.Varint, data: Uint8Array.of(7) }

	type.$unknown = [field]
	wire.$unknown = [field]
	Object.freeze(field)
	Object.freeze(type.$unknown)
	Object.freeze(wire.$unknown)
	Object.freeze(type.type)
	Object.freeze(type)
	Object.freeze(wire.value)
	Object.freeze(wire.items)
	Object.freeze(wire.pairs)
	Object.freeze(wire)

	let parameter = encodeParameters({ input }).$input!

	expect(parameter.type).toBe(type)
	expect(parameter.value).toBe(wire)
	expect(parameter.value!.value.case === 'bytesValue' && parameter.value!.value.value).toBe(bytes)
	expect(parameter.type!.$unknown![0]).toBe(field)
	expect(parameter.value!.$unknown![0]).toBe(field)
})

test('parameter validation rejects a string stored in a boolean wire field', () => {
	let input = new Bool(false)
	// @ts-expect-error JavaScript callers can mutate the encoded scalar.
	input.encode().value = { case: 'boolValue', value: 'false' }

	expect(() => {
		return encodeParameters({ input })
	}).toThrow(/boolean/)
})

test('parameter validation rejects a non-string stored in a text wire field', () => {
	let input = new Text('valid')
	// @ts-expect-error JavaScript callers can mutate the encoded scalar.
	input.encode().value = { case: 'textValue', value: 123 }

	expect(() => {
		return encodeParameters({ input })
	}).toThrow(/string/)
})

test('parameter validation rejects a lone surrogate inside a custom list value', () => {
	let list = new List(new Text('valid'))
	let wire = list.encode()
	wire.items[0]!.value = { case: 'textValue', value: '\ud800' }
	let input = {
		type: list.type,
		encode: () => {
			return wire
		},
	}

	expect(() => {
		return encodeParameters({ input })
	}).toThrow(/invalid UTF8/)
})

test('parameter validation rejects a numeric string stored in a double wire field', () => {
	let input = new Double(1.5)
	// @ts-expect-error JavaScript callers can mutate the encoded scalar.
	input.encode().value = { case: 'doubleValue', value: '1.5' }

	expect(() => {
		return encodeParameters({ input })
	}).toThrow(/number/)
})

test('parameter validation rejects a numeric string stored in an int32 wire field', () => {
	let input = new Int32(1)
	// @ts-expect-error JavaScript callers can mutate the encoded scalar.
	input.encode().value = { case: 'int32Value', value: '1' }

	expect(() => {
		return encodeParameters({ input })
	}).toThrow(/number/)
})

test('parameter validation rejects an out-of-range int64 wire field', () => {
	let input = new Int64(0n)
	input.encode().value = { case: 'int64Value', value: 2n ** 63n }

	expect(() => {
		return encodeParameters({ input })
	}).toThrow(/out of range/)
})

test('parameter validation rejects custom PostgreSQL values, including nested parameters', () => {
	let type = create(TypeSchema, {
		type: { case: 'pgType', value: { typeName: 'pgint4', oid: 23 } },
	})
	let wire = new Text('42').encode()
	let value = {
		type: {
			kind: TypeKind.PRIMITIVE,
			encode: () => {
				return type
			},
		},
		encode: () => {
			return wire
		},
	}

	for (let input of [value, new List(value)]) {
		expect(() => {
			return encodeParameters({ input })
		}).toThrow('PostgreSQL query parameters are not supported')
	}
})
