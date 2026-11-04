import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import * as Ydb from '@ydbjs/api/value'
import { expect, test } from 'vitest'
import { Empty, EmptyDict, EmptyDictType, EmptyList, EmptyListType, EmptyType } from './empty.js'
import { fromYdb, toJs } from './index.js'
import { Int32, Int32Type } from './primitive.js'

for (let [caseName, native] of [
	['emptyListType', []],
	['emptyDictType', new Map()],
] as const) {
	test(`preserves ${caseName} separately from typed containers`, () => {
		let type = create(Ydb.TypeSchema, { type: { case: caseName, value: 0 } })
		let wire = create(Ydb.ValueSchema)
		let decoded = fromYdb(wire, type)
		expect(decoded.type.encode()).toEqual(type)
		expect(decoded.encode()).toEqual(wire)
		expect(toJs(decoded)).toEqual(native)
	})
}

test('named empty constructors preserve their distinct protocol types', () => {
	for (let [value, type, name] of [
		[new EmptyList(), new EmptyListType(), 'emptyListType'],
		[new EmptyDict(), new EmptyDictType(), 'emptyDictType'],
	] as const) {
		expect(value.type.encode()).toEqual(type.encode())
		expect(value.type.encode().type).toEqual({ case: name, value: 0 })
		let wire = fromBinary(Ydb.ValueSchema, toBinary(Ydb.ValueSchema, value.encode()))
		expect(wire.value.case).toBeUndefined()
		expect(wire.items).toEqual([])
		expect(wire.pairs).toEqual([])
		expect(fromYdb(wire, type.encode()).type.encode()).toEqual(type.encode())
	}
	expect(() => new EmptyType(0 as never)).toThrow('EmptyType requires EmptyList or EmptyDict')
})

test('empty values reject incompatible schemas and scalar payloads', () => {
	expect(() => new Empty(new Int32Type() as never)).toThrow(/EmptyType/)
	let scalar = new Int32(42).encode()

	for (let value of [new EmptyList(), new EmptyDict()]) {
		expect(() => fromYdb(scalar, value.type.encode())).toThrow(/Empty/)
	}
})
