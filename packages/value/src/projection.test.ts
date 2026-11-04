import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import { install } from 'temporal-polyfill/shim'
import * as Ydb from '@ydbjs/api/value'
import { expect, test } from 'vitest'

import { fromJs, fromYdb, toJs } from './index.js'
import {
	Datetime,
	Interval,
	Timestamp,
	TzDate,
	TzDatetime,
	TzTimestamp,
	Date as YdbDate,
} from './primitive.js'
import { typeToString } from './print.js'

install()

test('preserves extended temporal values and their exact wire representation', () => {
	for (let [id, scalar] of [
		[Ydb.Type_PrimitiveTypeId.DATE32, { case: 'int32Value', value: -1 }],
		[Ydb.Type_PrimitiveTypeId.DATETIME64, { case: 'int64Value', value: -1n }],
		[Ydb.Type_PrimitiveTypeId.TIMESTAMP64, { case: 'int64Value', value: -1n }],
		[Ydb.Type_PrimitiveTypeId.INTERVAL64, { case: 'int64Value', value: -9007199254740993n }],
	] as const) {
		let type = create(Ydb.TypeSchema, { type: { case: 'typeId', value: id } })
		let wire = fromBinary(
			Ydb.ValueSchema,
			toBinary(Ydb.ValueSchema, create(Ydb.ValueSchema, { value: scalar }))
		)
		let decoded = fromYdb(wire, type)
		expect(decoded.type.encode()).toEqual(type)
		expect(decoded.encode()).toEqual(wire)
		expect(toJs(decoded)).toBe(decoded)
	}
})

test('retains existing Date and number projections', () => {
	for (let [value, native] of [
		[new YdbDate(1), new Date('1970-01-02T00:00:00Z')],
		[new Datetime(1), new Date('1970-01-01T00:00:01Z')],
		[new Timestamp(1001n), new Date('1970-01-01T00:00:00.001Z')],
		[new Interval(-4294967297), -4294967297],
	] as const) {
		let decoded = fromYdb(value.encode(), value.type.encode())
		expect(toJs(decoded)).toEqual(native)
	}
})

test('preserves timezone values without losing their date, zone or microseconds', () => {
	for (let zone of ['Asia/Tokyo', 'America/New_York']) {
		for (let value of [
			new TzDate(`2025-01-15,${zone}`),
			new TzDatetime(`2025-01-15T12:34:56,${zone}`),
			new TzTimestamp(`2025-01-15T12:34:56.123456,${zone}`),
		]) {
			let decoded = fromYdb(value.encode(), value.type.encode())
			expect(toJs(decoded)).toBe(decoded)
			expect(decoded.type.encode()).toEqual(value.type.encode())
			expect(decoded.encode()).toEqual(value.encode())
		}
	}
})

test('empty typed arrays retain their known element type', () => {
	for (let [input, expected] of [
		[new Float32Array(), 'List<Float>'],
		[new Float64Array(), 'List<Double>'],
		[new BigInt64Array(), 'List<Int64>'],
		[new BigUint64Array(), 'List<Uint64>'],
	] as const) {
		let value = fromJs(input)
		expect(typeToString(value.type)).toBe(expected)
		expect(toJs(fromYdb(value.encode(), value.type.encode()))).toEqual([])
	}
})

test('preserves DyNumber schema and wire data in the default projection', () => {
	let type = create(Ydb.TypeSchema, {
		type: { case: 'typeId', value: Ydb.Type_PrimitiveTypeId.DYNUMBER },
	})
	let wire = create(Ydb.ValueSchema, { value: { case: 'textValue', value: '123.456' } })
	let decoded = fromYdb(fromBinary(Ydb.ValueSchema, toBinary(Ydb.ValueSchema, wire)), type)
	expect(decoded.type.encode()).toEqual(type)
	expect(decoded.encode()).toEqual(wire)
	expect(toJs(decoded)).toBe(decoded)
})
