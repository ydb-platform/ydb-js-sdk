import { install } from 'temporal-polyfill/shim'
import { Temporal } from 'temporal-polyfill'
import { fromBinary, toBinary } from '@bufbuild/protobuf'
import * as Ydb from '@ydbjs/api/value'
import { expect, test } from 'vitest'
import { toJs } from './index.js'
import type { Value } from './value.js'
import {
	Date32,
	Datetime64,
	Interval64,
	Primitive,
	Timestamp64,
	TzDate,
	TzDate32,
	TzDatetime,
	TzTimestamp,
	TzTimestamp64,
	TzTimestamp64Type,
} from './primitive.js'

install()
function convert(value: Value) {
	return toJs(value, { temporal: true })
}

function decodeZone(text: string): Temporal.ZonedDateTime {
	return convert(
		new Primitive({ value: { case: 'textValue', value: text } }, new TzTimestamp64Type())
	) as Temporal.ZonedDateTime
}

test('calendar dates preserve exact epoch days across the Date32 range', () => {
	for (let days of [-53_375_809, -719_469, -1, 0, 49_672, 53_375_807]) {
		let date = convert(new Date32(days)) as Temporal.PlainDate
		expect(date).toBeInstanceOf(Temporal.PlainDate)
		expect(new Date32(date).value).toBe(days)
	}
	expect(convert(new Date32(-1))!.toString()).toBe('1969-12-31')
	expect(new Date32(Temporal.PlainDate.from('0000-02-29')).value).toBe(-719_469)
})

test('instants preserve microseconds before the epoch and at Timestamp64 limits', () => {
	for (let us of [
		-4_611_669_897_600_000_000n,
		-1_000_001n,
		-1n,
		0n,
		1n,
		4_291_747_199_999_999n,
		4_611_669_811_199_999_999n,
	]) {
		let instant = convert(new Timestamp64(us)) as Temporal.Instant
		expect(instant.epochNanoseconds).toBe(us * 1000n)
		expect(new Timestamp64(instant).value).toBe(us)
	}
	for (let seconds of [-4_611_669_897_600n, -1n, 0n, 4_611_669_811_199n]) {
		let instant = convert(new Datetime64(seconds)) as Temporal.Instant
		expect(new Datetime64(instant).value).toBe(seconds)
	}
})

test('durations preserve the complete signed Interval64 range through exact components', () => {
	for (let us of [
		-9_223_339_708_799_999_999n,
		-9_007_199_254_740_993n,
		-1n,
		0n,
		1n,
		9_007_199_254_740_993n,
		9_223_339_708_799_999_999n,
	]) {
		let duration = convert(new Interval64(us)) as Temporal.Duration
		expect(Number.isSafeInteger(duration.seconds)).toBe(true)
		expect(Number.isSafeInteger(duration.microseconds)).toBe(true)
		expect(new Interval64(duration).value).toBe(us)
	}
	expect(
		new Interval64(
			Temporal.Duration.from({
				hours: 1,
				minutes: 2,
				seconds: 3,
				milliseconds: 4,
				microseconds: 5,
			})
		).value
	).toBe(3_723_004_005n)
	expect(new Interval64(Temporal.Duration.from({ nanoseconds: 1000 })).value).toBe(1n)
})

test('timezone text preserves microseconds and translates historical BCE years', () => {
	let text = '-1-02-29T12:34:56.123456,UTC'
	let date = decodeZone(text)

	expect([
		date.year,
		date.month,
		date.day,
		date.hour,
		date.millisecond,
		date.microsecond,
	]).toEqual([0, 2, 29, 12, 123, 456])

	let value = new TzTimestamp64(date)
	let wire = fromBinary(Ydb.ValueSchema, toBinary(Ydb.ValueSchema, value.encode()))

	expect(value.value).toBe(text)
	expect(wire.value.value).toBe(text)
	expect(new TzTimestamp64(text).value).toBe(text)
	expect(decodeZone('1-01-01T00:00:00,UTC').year).toBe(1)
	expect(decodeZone('10000-01-01T00:00:00,UTC').year).toBe(10000)
	expect(() => decodeZone('0-01-01T00:00:00,UTC')).toThrow(/year zero/)
})

test('timezone timestamps cover the full UTC range with exact microseconds', () => {
	for (let us of [-4_611_669_897_600_000_000n, 4_611_669_811_199_999_999n]) {
		let date = Temporal.Instant.fromEpochNanoseconds(us * 1000n).toZonedDateTimeISO('UTC')
		expect(decodeZone(new TzTimestamp64(date).value as string).epochNanoseconds).toBe(
			us * 1000n
		)
	}
	for (let us of [-4_611_669_897_600_000_001n, 4_611_669_811_200_000_000n])
		expect(
			() =>
				new TzTimestamp64(
					Temporal.Instant.fromEpochNanoseconds(us * 1000n).toZonedDateTimeISO('UTC')
				)
		).toThrow(/YDB range/)
	for (let us of [-1n, 4_291_747_200_000_000n])
		expect(
			() =>
				new TzTimestamp(
					Temporal.Instant.fromEpochNanoseconds(us * 1000n).toZonedDateTimeISO('UTC')
				)
		).toThrow(/YDB range/)
})

test('timezone conversion rejects skipped and repeated local times', () => {
	for (let text of [
		'2025-03-09T02:30:00,America/New_York',
		'2025-11-02T01:30:00,America/New_York',
	])
		expect(() => decodeZone(text)).toThrow(RangeError)

	let text = '2025-11-02T02:30:00,America/New_York'
	expect(new TzDatetime(decodeZone(text)).value).toBe(text)
})

test('timezone dates retain their date and zone without inventing a native time', () => {
	let date = Temporal.ZonedDateTime.from('2025-01-01T12:34:56.123456789[Asia/Tokyo]')
	expect(new TzDate(date).value).toBe('2025-01-01,Asia/Tokyo')
	expect(new TzDate32('-1-02-29,UTC').value).toBe('-1-02-29,UTC')
	expect(() => decodeZone('2025-01-01,UTC')).toThrow(/no Temporal equivalent/)
})
