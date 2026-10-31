import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import { TZDate } from '@date-fns/tz'
import * as Ydb from '@ydbjs/api/value'
import { expect, test } from 'vitest'

import { fromJs, fromYdb, toJs } from './index.js'
import { TzDate, TzDatetime, TzTimestamp } from './primitive.js'
import { typeToString } from './print.js'

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

for (let [scaled, precision, scale, native] of [
	[0n, 22, 9, '0'],
	[1200n, 10, 2, '12'],
	[-123456000001n, 22, 9, '-123.456000001'],
	[1n, 35, 35, '0.00000000000000000000000000000000001'],
	[10n ** 35n - 1n, 35, 0, '99999999999999999999999999999999999'],
	[10n ** 35n, 22, 9, 'inf'],
	[-(10n ** 35n), 22, 9, '-inf'],
	[10n ** 35n + 1n, 22, 9, 'nan'],
] as const) {
	test(`decodes Decimal ${native} with precision ${precision} and scale ${scale}`, () => {
		let type = create(Ydb.TypeSchema, {
			type: { case: 'decimalType', value: { precision, scale } },
		})
		let wire = create(Ydb.ValueSchema, {
			value: { case: 'low128', value: BigInt.asUintN(64, scaled) },
			high128: BigInt.asUintN(64, scaled >> 64n),
		})
		let decoded = fromYdb(fromBinary(Ydb.ValueSchema, toBinary(Ydb.ValueSchema, wire)), type)
		expect(decoded.type.encode()).toEqual(type)
		expect(decoded.encode()).toEqual(wire)
		expect(toJs(decoded)).toBe(native)
		expect(typeToString(decoded.type)).toBe(`Decimal(${precision},${scale})`)
	})
}

test('projects supported extended scalar types without dropping their wire representation', () => {
	let cases: [Ydb.Type_PrimitiveTypeId, Ydb.Value['value'], unknown][] = [
		[
			Ydb.Type_PrimitiveTypeId.DATE32,
			{ case: 'int32Value', value: -1 },
			new Date('1969-12-31T00:00:00Z'),
		],
		[
			Ydb.Type_PrimitiveTypeId.DATETIME64,
			{ case: 'int64Value', value: -1n },
			new Date('1969-12-31T23:59:59Z'),
		],
		[
			Ydb.Type_PrimitiveTypeId.TIMESTAMP64,
			{ case: 'int64Value', value: -1000n },
			new Date('1969-12-31T23:59:59.999Z'),
		],
		[
			Ydb.Type_PrimitiveTypeId.INTERVAL,
			{ case: 'int64Value', value: -4294967297n },
			-4294967297,
		],
		[
			Ydb.Type_PrimitiveTypeId.INTERVAL64,
			{ case: 'int64Value', value: -9007199254740993n },
			-9007199254740993n,
		],
		[Ydb.Type_PrimitiveTypeId.DYNUMBER, { case: 'textValue', value: '123.456' }, '123.456'],
	]
	for (let [id, scalar, native] of cases) {
		let type = create(Ydb.TypeSchema, { type: { case: 'typeId', value: id } })
		let wire = fromBinary(
			Ydb.ValueSchema,
			toBinary(Ydb.ValueSchema, create(Ydb.ValueSchema, { value: scalar }))
		)
		let decoded = fromYdb(wire, type)
		expect(decoded.type.encode()).toEqual(type)
		expect(decoded.encode()).toEqual(wire)
		expect(toJs(decoded)).toEqual(native)
	}
})

test('reads timezone wall-clock fields in their declared timezone', () => {
	for (let zone of ['Asia/Tokyo', 'America/New_York']) {
		for (let month of [0, 6]) {
			for (let milliseconds of [0, 1, 10, 99, 100, 999]) {
				let input = TZDate.tz(zone, 2025, month, 15, 12, 34, 56, milliseconds)
				let value = new TzTimestamp(input)
				let actual = toJs(fromYdb(value.encode(), value.type.encode())) as TZDate
				expect(actual.getTime()).toBe(input.getTime())
				expect(actual.timeZone).toBe(zone)
			}
		}
		let date = TZDate.tz(zone, 2025, 0, 1)
		for (let value of [new TzDate(date), new TzDatetime(date), fromJs(date)]) {
			expect((toJs(fromYdb(value.encode(), value.type.encode())) as Date).getTime()).toBe(
				date.getTime()
			)
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
