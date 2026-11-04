import { install } from 'temporal-polyfill/shim'
import { fromBinary, toBinary } from '@bufbuild/protobuf'
import * as Ydb from '@ydbjs/api/value'
import { Temporal } from 'temporal-polyfill'
import { expect, test } from 'vitest'
import {
	Date32,
	Datetime,
	Datetime64,
	Interval64,
	Timestamp,
	Timestamp64,
	Date as YdbDate,
} from './primitive.js'
import type { Value } from './value.js'

install()

function binary(value: Value): Ydb.Value {
	return fromBinary(Ydb.ValueSchema, toBinary(Ydb.ValueSchema, value.encode()))
}

test('constructs extended temporal values in exact wire units', () => {
	for (let [value, field, expected] of [
		[new Date32(-53_375_809), 'int32Value', -53_375_809],
		[new Date32(53_375_807), 'int32Value', 53_375_807],
		[new Datetime64(-4_611_669_897_600n), 'int64Value', -4_611_669_897_600n],
		[new Datetime64(4_611_669_811_199n), 'int64Value', 4_611_669_811_199n],
		[new Timestamp64(-4_611_669_897_600_000_000n), 'int64Value', -4_611_669_897_600_000_000n],
		[new Timestamp64(4_611_669_811_199_999_999n), 'int64Value', 4_611_669_811_199_999_999n],
		[new Interval64(-9_223_339_708_799_999_999n), 'int64Value', -9_223_339_708_799_999_999n],
		[new Interval64(9_223_339_708_799_999_999n), 'int64Value', 9_223_339_708_799_999_999n],
	] as const) {
		expect(binary(value).value).toEqual({ case: field, value: expected })
	}
})

test('rejects temporal units outside the server ranges without rounding', () => {
	for (let createValue of [
		() => new Date32(-53_375_810),
		() => new Date32(53_375_808),
		() => new Date32(0.5),
		() => new Datetime64(-4_611_669_897_601n),
		() => new Datetime64(4_611_669_811_200n),
		() => new Timestamp64(-4_611_669_897_600_000_001n),
		() => new Timestamp64(4_611_669_811_200_000_000n),
		() => new Interval64(9_223_339_708_800_000_000n),
		() => new Interval64(-9_223_339_708_800_000_000n),
		() => new Interval64(9007199254740992),
	])
		expect(createValue).toThrow(/range/)
})

test('accepts Temporal inputs and exact wire units for time types', () => {
	expect(binary(new Date32(Temporal.PlainDate.from('1969-12-31'))).value.value).toBe(-1)
	expect(binary(new Datetime64(Temporal.Instant.from('1969-12-31T23:59:59Z'))).value.value).toBe(
		-1n
	)
	expect(
		binary(new Timestamp64(Temporal.Instant.from('1969-12-31T23:59:59.123456Z'))).value.value
	).toBe(-876544n)
	expect(binary(new Interval64(Temporal.Duration.from('-PT0.000001S'))).value.value).toBe(-1n)
	expect(binary(new YdbDate(0)).value.value).toBe(0)
	expect(binary(new Datetime(1)).value.value).toBe(1)
	expect(binary(new Timestamp(1n)).value.value).toBe(1n)
	expect(binary(new Interval64(-1)).value.value).toBe(-1n)
})

test('instant conversion rejects excess precision instead of rounding', () => {
	for (let ns of [-1n, 1n, 1001n]) {
		let instant = Temporal.Instant.fromEpochNanoseconds(ns)
		expect(() => new Timestamp64(instant)).toThrow(/precision/)
		expect(() => new Datetime64(instant)).toThrow(/precision/)
	}
})

test('interval conversion rejects calendar units and excess nanoseconds', () => {
	for (let field of ['years', 'months', 'weeks', 'days'])
		expect(() => new Interval64(Temporal.Duration.from({ [field]: 1 }))).toThrow(/calendar/)
	for (let ns of [-1, 1, 1001])
		expect(() => new Interval64(Temporal.Duration.from({ nanoseconds: ns }))).toThrow(
			/precision/
		)
})
