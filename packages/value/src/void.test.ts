import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import * as Ydb from '@ydbjs/api/value'
import { expect, test } from 'vitest'
import { fromYdb } from './index.js'
import { Optional } from './optional.js'
import { Int32 } from './primitive.js'
import type { Value } from './value.js'
import { Void, VoidType } from './void.js'

function roundTrip(value: Value): Value {
	let type = fromBinary(Ydb.TypeSchema, toBinary(Ydb.TypeSchema, value.type.encode()))
	let wire = fromBinary(Ydb.ValueSchema, toBinary(Ydb.ValueSchema, value.encode()))
	let decoded = fromYdb(wire, type)
	expect(decoded.type.encode()).toEqual(type)
	expect(decoded.encode()).toEqual(wire)
	return decoded
}

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

test('Void rejects scalar payloads', () => {
	let scalar = new Int32(42).encode()

	expect(() => fromYdb(scalar, new VoidType().encode())).toThrow(/Empty/)
})
