import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import * as Ydb from '@ydbjs/api/value'
import { expect, test } from 'vitest'

import { fromJs, fromYdb, toJs } from './index.js'
import { List, ListType } from './list.js'
import { Dict, DictType } from './dict.js'
import { Optional, OptionalType } from './optional.js'
import { Int32, Int32Type, Text, TextType, Uuid } from './primitive.js'
import { Struct, StructType } from './struct.js'
import type { Type } from './type.js'
import { Null } from './null.js'
import { Tuple } from './tuple.js'
import type { Value } from './value.js'

function roundTrip(value: Value): Value {
	let type = fromBinary(Ydb.TypeSchema, toBinary(Ydb.TypeSchema, value.type.encode()))
	let wire = fromBinary(Ydb.ValueSchema, toBinary(Ydb.ValueSchema, value.encode()))
	let decoded = fromYdb(wire, type)
	expect(decoded.type.encode()).toEqual(type)
	expect(decoded.encode()).toEqual(wire)
	return decoded
}

for (let depth of [1, 2, 3]) {
	for (let absent of [-1, ...Array.from({ length: depth }, (_, i) => i)]) {
		test(`preserves Optional depth ${depth} with absence at ${absent}`, () => {
			let type: Type = new Int32Type()
			let value: Value = new Int32(42)
			for (let level = depth - 1; level >= 0; level--) {
				value = new Optional(level === absent ? null : value, type)
				type = value.type
			}
			let decoded = roundTrip(value)
			expect(toJs(decoded)).toEqual(absent === -1 ? 42 : null)
			let current: Value | null = decoded
			let presence: boolean[] = []
			for (let level = 0; level < depth && current !== null; level++) {
				expect(current).toBeInstanceOf(Optional)
				current = (current as Optional<Type>).item
				presence.push(current !== null)
			}
			expect(presence).toEqual(
				Array.from(
					{ length: absent === -1 ? depth : absent + 1 },
					(_, level) => level !== absent
				)
			)
		})
	}
}

test('retains both UUID halves through binary decode and typed encode', () => {
	let text = '00112233-4455-6677-8899-aabbccddeeff'
	expect(toJs(roundTrip(new Uuid(text)))).toBe(text)
})

test('decodes typed empty and nullable containers without inferring their schema', () => {
	let types = [
		new ListType(new Int32Type()),
		new DictType(new TextType(), new Int32Type()),
		new ListType(new OptionalType(new Int32Type())),
	]
	for (let type of types) {
		let wire = create(Ydb.ValueSchema)
		let decoded = fromYdb(wire, type.encode())
		expect(decoded.type.encode()).toEqual(type.encode())
		expect(decoded.encode()).toEqual(wire)
	}
	let list = new List(new Optional(new Int32(1)), new Optional(null, new Int32Type()))
	expect(toJs(roundTrip(list))).toEqual([1, null])
})

test('rejects incompatible container schemas before encoding', () => {
	expect(() => new List(new Int32(1), new Text('two'))).toThrow(/type/i)
	expect(() => new Dict([new Int32(1), new Text('a')], [new Text('key'), new Text('b')])).toThrow(
		/type/i
	)
	expect(() => new Dict([new Int32(1), new Int32(2)], [new Int32(3), new Text('b')])).toThrow(
		/type/i
	)
	let type = new StructType(['x'], [new Int32Type()])
	expect(() => new Struct({ x: new Text('abc') }, type)).toThrow(/type/i)
	expect(() => new Optional(new Text('abc'), new Int32Type())).toThrow(/type/i)
	expect(() => fromJs([{ x: { a: 1 } }, { x: { b: 2 } }])).toThrow(/type/i)
	expect(() => fromJs([{ x: null }, { x: 1 }])).toThrow(/type/i)
	expect(() => fromJs([{ x: 1 }, { x: null }])).toThrow(/type/i)
})

test('does not read inherited fields of a struct with an explicit schema', () => {
	let type = new StructType(
		['__proto__', 'constructor', 'toString'],
		Array.from({ length: 3 }, () => new OptionalType(new Int32Type()))
	)
	let value = new Struct({}, type)
	expect(toJs(roundTrip(value))).toEqual(
		JSON.parse('{"__proto__":null,"constructor":null,"toString":null}')
	)
})

test('classifies array elements through the same rules as standalone values', () => {
	let cases = [
		[new Date('2025-01-01T00:00:00Z')],
		[new Map([['a', 1]])],
		[new Uint8Array([1, 2])],
		[new Set([1, 'a'])],
		[new Int32(1)],
	]
	for (let values of cases) {
		let expected = values.map((value) => toJs(fromJs(value as never)))
		expect(toJs(roundTrip(fromJs(values as never)))).toEqual(expected)
	}
})

test('constructs typed empty lists and dictionaries explicitly', () => {
	let list = new List([], new ListType(new OptionalType(new Int32Type())))
	let dict = new Dict([], new DictType(new TextType(), list.type))
	expect(toJs(roundTrip(list))).toEqual([])
	expect(toJs(roundTrip(dict))).toEqual(new Map())
	let value = new Struct({ list, dict, tuple: new Tuple<Value>(list, dict) })
	expect(toJs(roundTrip(value))).toEqual({ list: [], dict: new Map(), tuple: [[], new Map()] })
	expect(() => new List([new Text('x')], new ListType(new Int32Type()))).toThrow(/type/i)
	expect(
		() =>
			new Dict([[new Int32(1), new Int32(2)]], new DictType(new TextType(), new Int32Type()))
	).toThrow(/type/i)
})

test('compares nested schemas and struct positions, not just their outer kind', () => {
	let mismatches: [Value, Value][] = [
		[new Optional(new Int32(1)), new Optional(new Text('a'))],
		[new List(new Int32(1)), new List(new Text('a'))],
		[new Struct({ a: new Int32(1) }), new Struct({ b: new Int32(2) })],
		[
			new Struct({ a: new Int32(1), b: new Text('b') }),
			new Struct(
				{ a: new Int32(1), b: new Text('b') },
				new StructType(['b', 'a'], [new TextType(), new Int32Type()], true)
			),
		],
	]
	for (let [left, right] of mismatches) {
		expect(() => new List(left, right)).toThrow(/type/i)
		expect(() => new Struct({ value: right }, new StructType(['value'], [left.type]))).toThrow(
			/type/i
		)
	}
})

test('distinguishes an absent optional from a present Null value', () => {
	let present = new Optional(new Null())
	let absent = new Optional(null, new Null().type)
	expect(present.encode().value.case).toBe('nestedValue')
	expect(absent.encode().value.case).toBe('nullFlagValue')
	expect((roundTrip(present) as Optional<Type>).item).toBeInstanceOf(Null)
	expect((roundTrip(absent) as Optional<Type>).item).toBeNull()
})

test('decodes a wrapped present scalar optional to the same typed value', () => {
	let value = new Optional(new Int32(42))
	let decoded = fromYdb(
		create(Ydb.ValueSchema, { value: { case: 'nestedValue', value: value.item!.encode() } }),
		value.type.encode()
	)
	expect(decoded.type.encode()).toEqual(value.type.encode())
	expect(decoded.encode()).toEqual(value.encode())
	expect(toJs(decoded)).toBe(42)
})

test('preserves wire struct ordering without reassigning field values', () => {
	let type = new StructType(['z', 'a'], [new Int32Type(), new TextType()], true)
	let original = new Struct({ z: new Int32(42), a: new Text('a') }, type)
	let decoded = roundTrip(original) as Struct
	expect(decoded.type.names).toEqual(['z', 'a'])
	expect(toJs(decoded)).toEqual({ z: 42, a: 'a' })
})
