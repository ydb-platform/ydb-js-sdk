import { install } from 'temporal-polyfill/shim'

import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import * as Ydb from '@ydbjs/api/value'
import { Temporal } from 'temporal-polyfill'
import { expect, test } from 'vitest'

import { fromJs, fromYdb, toJs } from './index.js'
import {
	Datetime,
	Interval,
	Timestamp,
	TzDate,
	TzDate32,
	TzDatetime,
	TzDatetime64,
	TzTimestamp,
	TzTimestamp64,
	Date as YdbDate,
} from './primitive.js'

install()

test('preserves extended temporal values by default and projects Temporal explicitly', () => {
	let cases: [
		Ydb.Type_PrimitiveTypeId,
		Ydb.Value['value'],
		Temporal.PlainDate | Temporal.Instant | Temporal.Duration,
	][] = [
		[
			Ydb.Type_PrimitiveTypeId.DATE32,
			{ case: 'int32Value', value: -1 },
			Temporal.PlainDate.from('1969-12-31'),
		],
		[
			Ydb.Type_PrimitiveTypeId.DATETIME64,
			{ case: 'int64Value', value: -1n },
			Temporal.Instant.from('1969-12-31T23:59:59Z'),
		],
		[
			Ydb.Type_PrimitiveTypeId.TIMESTAMP64,
			{ case: 'int64Value', value: -1n },
			Temporal.Instant.from('1969-12-31T23:59:59.999999Z'),
		],
		[
			Ydb.Type_PrimitiveTypeId.INTERVAL64,
			{ case: 'int64Value', value: -9007199254740993n },
			Temporal.Duration.from('-PT9007199254.740993S'),
		],
	]
	for (let [id, scalar, temporal] of cases) {
		let type = create(Ydb.TypeSchema, { type: { case: 'typeId', value: id } })
		let wire = fromBinary(
			Ydb.ValueSchema,
			toBinary(Ydb.ValueSchema, create(Ydb.ValueSchema, { value: scalar }))
		)
		let decoded = fromYdb(wire, type)
		expect(decoded.type.encode()).toEqual(type)
		expect(decoded.encode()).toEqual(wire)
		expect(toJs(decoded)).toBe(decoded)
		expect(toJs(decoded, { temporal: false })).toBe(decoded)
		let actual = toJs(decoded, { temporal: true }) as typeof temporal
		expect(actual.constructor).toBe(temporal.constructor)
		expect(actual.toString()).toBe(temporal.toString())
	}
})

test('retains existing Date and number projections unless Temporal is requested', () => {
	for (let [value, legacy, temporal] of [
		[new YdbDate(1), new Date('1970-01-02T00:00:00Z'), Temporal.PlainDate.from('1970-01-02')],
		[
			new Datetime(1),
			new Date('1970-01-01T00:00:01Z'),
			Temporal.Instant.from('1970-01-01T00:00:01Z'),
		],
		[
			new Timestamp(1001n),
			new Date('1970-01-01T00:00:00.001Z'),
			Temporal.Instant.from('1970-01-01T00:00:00.001001Z'),
		],
		[new Interval(-4294967297), -4294967297, Temporal.Duration.from('-PT4294.967297S')],
	] as const) {
		let decoded = fromYdb(value.encode(), value.type.encode())
		expect(toJs(decoded)).toEqual(legacy)
		expect(toJs(decoded, { temporal: false })).toEqual(legacy)
		let actual = toJs(decoded, { temporal: true }) as typeof temporal
		expect(actual.constructor).toBe(temporal.constructor)
		expect(actual.toString()).toBe(temporal.toString())
	}
})

test('reads timezone wall-clock fields with explicit Temporal projection', () => {
	for (let zone of ['Asia/Tokyo', 'America/New_York']) {
		for (let month of [1, 7]) {
			for (let millisecond of [0, 1, 10, 99, 100, 999]) {
				let input = Temporal.ZonedDateTime.from({
					timeZone: zone,
					year: 2025,
					month,
					day: 15,
					hour: 12,
					minute: 34,
					second: 56,
					millisecond,
					microsecond: 123,
				})
				let value = new TzTimestamp(input)
				let decoded = fromYdb(value.encode(), value.type.encode())
				expect(toJs(decoded)).toBe(decoded)
				let actual = toJs(decoded, { temporal: true }) as Temporal.ZonedDateTime
				expect(actual.epochNanoseconds).toBe(input.epochNanoseconds)
				expect(actual.timeZoneId).toBe(input.timeZoneId)
			}
		}
		let input = Temporal.ZonedDateTime.from({ timeZone: zone, year: 2025, month: 1, day: 1 })
		for (let value of [
			new TzDatetime(input),
			new TzDatetime64(input),
			new TzTimestamp64(input),
			fromJs(input),
		]) {
			let decoded = fromYdb(value.encode(), value.type.encode())
			expect(toJs(decoded)).toBe(decoded)
			expect(toJs(decoded, { temporal: false })).toBe(decoded)
			let actual = toJs(decoded, { temporal: true }) as Temporal.ZonedDateTime
			expect(actual.epochNanoseconds).toBe(input.epochNanoseconds)
			expect(actual.timeZoneId).toBe(input.timeZoneId)
		}
		for (let value of [new TzDate(input), new TzDate32(input)]) {
			let decoded = fromYdb(value.encode(), value.type.encode())
			expect(toJs(decoded)).toBe(decoded)
			expect(toJs(decoded, { temporal: true })).toBe(decoded)
			expect(decoded.type.encode()).toEqual(value.type.encode())
			expect(decoded.encode()).toEqual(value.encode())
		}
	}
})
