import { fromBinary, toBinary } from '@bufbuild/protobuf'
import * as Ydb from '@ydbjs/api/value'
import { expect, test } from 'vitest'
import { fromYdb, toJs } from './index.js'
import { List } from './list.js'
import { Int32, Int32Type, Text } from './primitive.js'
import { Struct } from './struct.js'
import { Tagged, TaggedType } from './tagged.js'
import type { Value } from './value.js'

function roundTrip(value: Value): Value {
	let type = fromBinary(Ydb.TypeSchema, toBinary(Ydb.TypeSchema, value.type.encode()))
	let wire = fromBinary(Ydb.ValueSchema, toBinary(Ydb.ValueSchema, value.encode()))
	let decoded = fromYdb(wire, type)
	expect(decoded.type.encode()).toEqual(type)
	expect(decoded.encode()).toEqual(wire)
	return decoded
}

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

test('nested tags preserve the complete schema of ordinary composites', () => {
	let item = new Struct({ count: new Int32(7), names: new List(new Text('one')) })
	let value = new Tagged(new Tagged(item, 'inner'), 'outer')

	let decoded = roundTrip(value) as Tagged<Tagged<Struct>>

	expect(decoded.type.tag).toBe('outer')
	expect(decoded.item.type.tag).toBe('inner')
	expect(toJs(decoded.item.item)).toEqual({ count: 7, names: ['one'] })
	expect(decoded.encode()).toEqual(item.encode())
})

test('tagged values reject contents that contradict their declared item type', () => {
	let type = new TaggedType('id', new Int32Type())
	expect(() => new Tagged(new Text('x'), type)).toThrow(/expected type Int32/)
	expect(() => new Tagged(new Int32(1), 1 as never)).toThrow(/string tag or TaggedType/)
	expect(() => new TaggedType(1 as never, new Int32Type())).toThrow(/string tag/)
})
