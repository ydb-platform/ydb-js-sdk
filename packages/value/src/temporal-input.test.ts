import { install } from 'temporal-polyfill/shim'

import * as Ydb from '@ydbjs/api/value'
import { Temporal } from 'temporal-polyfill'
import { Temporal as ImplementationTemporal } from 'temporal-polyfill/implementation'
import { expect, test } from 'vitest'

import { fromJs } from './index.js'
import {
	Datetime,
	Interval,
	Timestamp,
	TzDate,
	TzDatetime,
	TzTimestamp,
	Date as YdbDate,
} from './primitive.js'
import type { Value } from './value.js'

install()

function encodeScalar(value: Value) {
	return { type: value.type.encode().type, value: value.encode().value }
}

for (let [source, temporal] of [
	['selected', Temporal],
	['implementation', ImplementationTemporal],
] as const) {
	test(`infers all four supported ${source} Temporal input kinds`, () => {
		for (let [input, id, scalar] of [
			[
				temporal.PlainDate.from('1970-01-02'),
				Ydb.Type_PrimitiveTypeId.DATE,
				{ case: 'uint32Value', value: 1 },
			],
			[
				temporal.Instant.from('1970-01-01T00:00:00.001001Z'),
				Ydb.Type_PrimitiveTypeId.TIMESTAMP,
				{ case: 'uint64Value', value: 1001n },
			],
			[
				temporal.ZonedDateTime.from('1970-01-01T09:00:00.001001[Asia/Tokyo]'),
				Ydb.Type_PrimitiveTypeId.TZ_TIMESTAMP,
				{ case: 'textValue', value: '1970-01-01T09:00:00.001001,Asia/Tokyo' },
			],
			[
				temporal.Duration.from('-PT1.000001S'),
				Ydb.Type_PrimitiveTypeId.INTERVAL,
				{ case: 'int64Value', value: -1_000_001n },
			],
		] as const)
			expect(encodeScalar(fromJs(input))).toEqual({
				type: { case: 'typeId', value: id },
				value: scalar,
			})
	})

	test(`encodes ${source} Temporal inputs through explicit temporal constructors`, () => {
		let zoned = temporal.ZonedDateTime.from('1970-01-02T09:00:01[Asia/Tokyo]')
		for (let [value, id, scalar] of [
			[
				new YdbDate(temporal.PlainDate.from('1970-01-02')),
				Ydb.Type_PrimitiveTypeId.DATE,
				{ case: 'uint32Value', value: 1 },
			],
			[
				new Datetime(temporal.Instant.from('1970-01-01T00:00:01Z')),
				Ydb.Type_PrimitiveTypeId.DATETIME,
				{ case: 'uint32Value', value: 1 },
			],
			[
				new Timestamp(temporal.Instant.from('1970-01-01T00:00:00.001001Z')),
				Ydb.Type_PrimitiveTypeId.TIMESTAMP,
				{ case: 'uint64Value', value: 1001n },
			],
			[
				new Interval(temporal.Duration.from('-PT1.000001S')),
				Ydb.Type_PrimitiveTypeId.INTERVAL,
				{ case: 'int64Value', value: -1_000_001n },
			],
			[
				new TzDate(zoned),
				Ydb.Type_PrimitiveTypeId.TZ_DATE,
				{ case: 'textValue', value: '1970-01-02,Asia/Tokyo' },
			],
			[
				new TzDatetime(zoned),
				Ydb.Type_PrimitiveTypeId.TZ_DATETIME,
				{ case: 'textValue', value: '1970-01-02T09:00:01,Asia/Tokyo' },
			],
			[
				new TzTimestamp(zoned),
				Ydb.Type_PrimitiveTypeId.TZ_TIMESTAMP,
				{ case: 'textValue', value: '1970-01-02T09:00:01.000000,Asia/Tokyo' },
			],
		] as const)
			expect(encodeScalar(value)).toEqual({
				type: { case: 'typeId', value: id },
				value: scalar,
			})
	})

	test(`rejects non-ISO calendars from ${source} Temporal inputs`, () => {
		let date = temporal.PlainDate.from('2025-01-01[u-ca=gregory]')
		let zoned = temporal.ZonedDateTime.from('2025-01-01T00:00:00[UTC][u-ca=gregory]')
		for (let convert of [
			() => fromJs(date),
			() => fromJs(zoned),
			() => new YdbDate(date),
			() => new TzDate(zoned),
			() => new TzTimestamp(zoned),
		])
			expect(convert).toThrow(/ISO/)
	})

	test(`rejects precision loss from ${source} Temporal inputs`, () => {
		let instant = temporal.Instant.from('1970-01-01T00:00:01.000000001Z')
		let zoned = instant.toZonedDateTimeISO('UTC')
		let duration = temporal.Duration.from({ nanoseconds: 1 })
		for (let convert of [
			() => fromJs(instant),
			() => fromJs(zoned),
			() => fromJs(duration),
			() => new Timestamp(instant),
			() => new TzTimestamp(zoned),
			() => new Interval(duration),
		])
			expect(convert).toThrow(/precision/)
		let subsecond = temporal.Instant.from('1970-01-01T00:00:01.000001Z')
		for (let convert of [
			() => new Datetime(subsecond),
			() => new TzDatetime(subsecond.toZonedDateTimeISO('UTC')),
		])
			expect(convert).toThrow(/precision/)
	})

	test(`does not infer a timezone or scalar type for unsupported ${source} Temporal inputs`, () => {
		for (let input of [
			temporal.PlainDateTime.from('2025-01-01T12:34:56'),
			temporal.PlainTime.from('12:34:56'),
		])
			expect(() => fromJs(input as never)).toThrow(/no inferred YDB type/)
	})
}

test('retains Date input compatibility and its existing epoch-unit conversion', () => {
	let date = new Date('1970-01-02T00:00:01.123Z')
	expect(encodeScalar(fromJs(date))).toEqual({
		type: { case: 'typeId', value: Ydb.Type_PrimitiveTypeId.DATETIME },
		value: {
			case: 'uint32Value',
			value: 86_401,
		},
	})
	for (let [value, id, scalar] of [
		[new YdbDate(date), Ydb.Type_PrimitiveTypeId.DATE, { case: 'uint32Value', value: 1 }],
		[
			new Datetime(date),
			Ydb.Type_PrimitiveTypeId.DATETIME,
			{ case: 'uint32Value', value: 86_401 },
		],
		[
			new Timestamp(date),
			Ydb.Type_PrimitiveTypeId.TIMESTAMP,
			{ case: 'uint64Value', value: 86_401_123_000n },
		],
	] as const)
		expect(encodeScalar(value)).toEqual({ type: { case: 'typeId', value: id }, value: scalar })
})

test('typed constructors reject temporal kinds that would discard unspecified information', () => {
	let dateTime = Temporal.PlainDateTime.from('2025-01-01T12:34:56')
	expect(() => new YdbDate(dateTime as never)).toThrow(/PlainDate/)
	let zoned = Temporal.ZonedDateTime.from('2025-01-01T12:34:56[Asia/Tokyo]')
	for (let Input of [Timestamp, Datetime])
		expect(() => new Input(zoned as never)).toThrow(/Instant/)
})

test('interval inputs reject calendar units and excess nanoseconds', () => {
	for (let field of ['years', 'months', 'weeks', 'days'])
		expect(() => new Interval(Temporal.Duration.from({ [field]: 1 }))).toThrow(/calendar/)
	for (let ns of [-1, 1, 1001])
		expect(() => new Interval(Temporal.Duration.from({ nanoseconds: ns }))).toThrow(/precision/)
})

test('timezone inputs reject skipped and repeated local times', () => {
	for (let text of [
		'2025-03-09T02:30:00,America/New_York',
		'2025-11-02T01:30:00,America/New_York',
	])
		expect(() => new TzDatetime(text)).toThrow(RangeError)
	for (let offset of ['-04:00', '-05:00'])
		expect(
			() =>
				new TzDatetime(
					Temporal.ZonedDateTime.from(`2025-11-02T01:30:00${offset}[America/New_York]`)
				)
		).toThrow(RangeError)
})

test('timezone inputs reject incompatible fields and invalid zones', () => {
	for (let text of [
		'2025-02-30T00:00:00,UTC',
		'2025-01-01T24:00:00,UTC',
		'2025-01-01T00:00:00,Not/A/Timezone',
	])
		expect(() => new TzTimestamp(text)).toThrow(RangeError)
	expect(() => new TzTimestamp('2025-01-01T00:00:00.1234567,UTC')).toThrow(/YDB/)
	expect(() => new TzTimestamp('2025-01-01T00:00:60,UTC')).toThrow(/YDB/)
	expect(() => new TzDate('2025-01-01T00:00:00,UTC')).toThrow(/incompatible/)
	expect(() => new TzTimestamp('2025-01-01,UTC')).toThrow(/incompatible/)
	expect(() => new TzDatetime('2025-01-01T00:00:00.1,UTC')).toThrow(/incompatible/)
	expect(() => new TzDate('2011-12-30,Pacific/Apia')).toThrow(RangeError)
	let zoned = Temporal.ZonedDateTime.from('2025-01-01T00:00:00[Asia/Tokyo]')
	expect(() => new TzTimestamp(zoned.withTimeZone('+09:00'))).toThrow(/IANA/)
})

test('Temporal inputs stay within the declared legacy YDB ranges', () => {
	for (let input of [
		Temporal.PlainDate.from('1969-12-31'),
		Temporal.Instant.from('1969-12-31T23:59:59.999999Z'),
		Temporal.Duration.from({ seconds: 4_291_747_200 }),
		Temporal.ZonedDateTime.from('1969-12-31T23:59:59.999999[UTC]'),
	])
		expect(() => fromJs(input)).toThrow(/range/)
})
