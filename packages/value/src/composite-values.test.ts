import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import * as Ydb from '@ydbjs/api/value'
import { expect, test } from 'vitest'

import { fromYdb, toJs } from './index.js'
import { List } from './list.js'
import { Optional } from './optional.js'
import { Pg, PgType } from './pg.js'
import { Int32, Int32Type, Text, TextType } from './primitive.js'
import { Struct, StructType } from './struct.js'
import { Tagged, TaggedType } from './tagged.js'
import { TupleType } from './tuple.js'
import type { Value } from './value.js'
import { Variant, VariantType } from './variant.js'
import { Void, VoidType } from './void.js'

function roundTrip(value: Value): Value {
	let type = fromBinary(Ydb.TypeSchema, toBinary(Ydb.TypeSchema, value.type.encode()))
	let wire = fromBinary(Ydb.ValueSchema, toBinary(Ydb.ValueSchema, value.encode()))
	let decoded = fromYdb(wire, type)
	expect(decoded.type.encode()).toEqual(type)
	expect(decoded.encode()).toEqual(wire)
	return decoded
}

test('tuple variants preserve the selected alternative and its value', () => {
	let type = new VariantType(new TupleType([new Int32Type(), new TextType()]))
	let value = new Variant(new Text('answer'), 1, type)
	let decoded = roundTrip(value) as Variant
	expect(decoded).toBeInstanceOf(Variant)
	expect(decoded.index).toBe(1)
	expect(decoded.tag).toBe(1)
	expect(toJs(decoded.item)).toBe('answer')
	expect(decoded.encode()).toMatchObject({
		variantIndex: 1,
		value: { case: 'nestedValue', value: { value: { case: 'textValue', value: 'answer' } } },
	})
	expect(toJs(decoded)).toBe(decoded)
})

test('struct variants preserve names and positions from an explicit schema', () => {
	let type = new VariantType(
		new StructType(['z', '__proto__'], [new Int32Type(), new TextType()], true)
	)
	let decoded = roundTrip(new Variant(new Text('own'), '__proto__', type)) as Variant
	expect(decoded.index).toBe(1)
	expect(decoded.tag).toBe('__proto__')
	expect((decoded.type.items as StructType).names).toEqual(['z', '__proto__'])
	expect(toJs(decoded.item)).toBe('own')
})

test('nested variants keep both discriminators', () => {
	let inner = new Variant(
		new Int32(42),
		1,
		new VariantType(new TupleType([new Int32Type(), new Int32Type()]))
	)
	let outer = new Variant(
		inner,
		'right',
		new VariantType(new StructType(['left', 'right'], [new Int32Type(), inner.type]))
	)
	let decoded = roundTrip(outer) as Variant<Variant>
	expect(decoded.tag).toBe('right')
	expect(decoded.index).toBe(1)
	expect(decoded.item).toBeInstanceOf(Variant)
	expect(decoded.item.index).toBe(1)
	expect(toJs(decoded.item.item)).toBe(42)
})

test('variants reject missing alternatives and selectors of the wrong kind', () => {
	let type = new VariantType(new TupleType([new Int32Type(), new TextType()]))
	for (let index of [-1, 2, 0.5, NaN, Infinity]) {
		expect(() => new Variant(new Int32(1), index, type)).toThrow(/index/)
	}
	expect(() => new Variant(new Int32(1), '0', type)).toThrow(/integer alternative index/)
	let named = new VariantType(new StructType(['a'], [new Int32Type()]))
	expect(() => new Variant(new Int32(1), 'missing', named)).toThrow(/Unknown variant alternative/)
	expect(() => new Variant(new Int32(1), 0, named)).toThrow(/alternative name/)
	expect(() => new VariantType(new TupleType([]))).toThrow(/at least one alternative/)
	expect(() => new VariantType(new StructType([], []))).toThrow(/at least one alternative/)
	expect(() => new VariantType(new Int32Type() as never)).toThrow(/TupleType or StructType/)
})

test('variants check the complete selected schema before encoding', () => {
	let scalar = new VariantType(new TupleType([new Int32Type()]))
	expect(() => new Variant(new Text('x'), 0, scalar)).toThrow(/expected type Int32/)
	let nested = new VariantType(new TupleType([new StructType(['a'], [new Int32Type()])]))
	expect(() => new Variant(new Struct({ b: new Int32(1) }), 0, nested)).toThrow(
		/expected type Struct/
	)
})

test('tagged values preserve the tag and reuse the inner wire representation', () => {
	let item = new Int32(42)
	let type = new TaggedType('customer/id', item.type)
	let value = new Tagged(item, type)
	expect(value.type).toBe(type)
	expect(value.encode()).toEqual(item.encode())
	let decoded = roundTrip(value) as Tagged
	expect(decoded).toBeInstanceOf(Tagged)
	expect(decoded.type.tag).toBe('customer/id')
	expect(toJs(decoded.item)).toBe(42)
	expect(toJs(decoded)).toBe(decoded)
	expect(toJs(new List(decoded))).toEqual([decoded])
})

test('nested tags and variant payloads retain their complete schema', () => {
	let variant = new Variant(
		new Int32(7),
		'chosen',
		new VariantType(new StructType(['chosen'], [new Int32Type()]))
	)
	let value = new Tagged(new Tagged(variant, 'inner'), 'outer')
	let decoded = roundTrip(value) as Tagged<Tagged<Variant>>
	expect(decoded.type.tag).toBe('outer')
	expect(decoded.item.type.tag).toBe('inner')
	expect(decoded.item.item.tag).toBe('chosen')
	expect(decoded.encode()).toEqual(variant.encode())
})

test('tagged values reject contents that contradict their declared item type', () => {
	let type = new TaggedType('id', new Int32Type())
	expect(() => new Tagged(new Text('x'), type)).toThrow(/expected type Int32/)
	expect(() => new Tagged(new Int32(1), 1 as never)).toThrow(/string tag or TaggedType/)
	expect(() => new TaggedType(1 as never, new Int32Type())).toThrow(/string tag/)
})

test('Void retains a distinct type with an empty wire value', () => {
	let value = new Void()
	let decoded = roundTrip(value)
	expect(decoded).toBeInstanceOf(Void)
	expect(decoded.type).toBeInstanceOf(VoidType)
	expect(decoded.encode()).toEqual(create(Ydb.ValueSchema))
	expect(decoded.type.encode().type).toEqual({ case: 'voidType', value: 0 })
})

test('optional Void distinguishes an absent value from a present empty value', () => {
	let absent = roundTrip(new Optional(null, new VoidType())) as Optional<VoidType>
	let present = roundTrip(new Optional(new Void())) as Optional<VoidType>
	expect(absent.item).toBeNull()
	expect(present.item).toBeInstanceOf(Void)
	expect(absent.encode().value.case).toBe('nullFlagValue')
	expect(present.encode().value.case).toBeUndefined()
})

test('Pg type string shorthand produces canonical scalar and array names', () => {
	for (let [input, expected] of [
		['int4', 'pgint4'],
		['PgInt4', 'pgint4'],
		['_int4', '_pgint4'],
		['_PgInt4', '_pgint4'],
	] as const) {
		expect(new PgType(input).typeName).toBe(expected)
	}
	expect(new PgType({ oid: 23 }).encode().type).toMatchObject({
		case: 'pgType',
		value: { oid: 23, typeName: '' },
	})
})

test('Pg preserves descriptor metadata and opaque text, binary and null payloads', () => {
	let descriptor = { typeName: 'pgint4', typeModifier: '', oid: 23, typlen: 4, typmod: -1 }
	let type = new PgType(descriptor)
	let payloads = ['42', new Uint8Array([0, 0, 0, 42]), null]
	for (let payload of payloads) {
		let value = new Pg(payload, type)
		let decoded = roundTrip(value) as Pg
		expect(decoded).toBeInstanceOf(Pg)
		expect(decoded.value).toEqual(payload)
		expect(decoded.type).toMatchObject(descriptor)
		expect(toJs(decoded)).toBe(decoded)
	}
})

test('present optional Pg null remains distinct from an absent optional', () => {
	let type = new PgType({ typeName: 'pgint4', oid: 23, typlen: 4, typmod: -1 })
	let present = roundTrip(new Optional(new Pg(null, type))) as Optional<PgType>
	let absent = roundTrip(new Optional(null, type)) as Optional<PgType>
	expect(present.item).toBeInstanceOf(Pg)
	expect((present.item as Pg).value).toBeNull()
	expect(absent.item).toBeNull()
	expect(present.encode().value.case).toBe('nestedValue')
	expect(absent.encode().value.case).toBe('nullFlagValue')
})

test('Pg rejects invalid descriptors and non-wire payloads', () => {
	for (let descriptor of [
		{},
		{ oid: 0 },
		{ oid: -1 },
		{ oid: 1.5 },
		{ oid: 0x100000000 },
		{ typeName: 'pgint4', typlen: 0x80000000 },
		{ typeName: 'pgint4', typmod: -0x80000001 },
	]) {
		expect(() => new PgType(descriptor)).toThrow(/Pg/)
	}
	expect(() => new PgType('')).toThrow(/name or a nonzero OID/)
	expect(() => new Pg(42 as never, new PgType('int4'))).toThrow(/text, binary bytes, or null/)
})
