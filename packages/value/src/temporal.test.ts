import { fromBinary, toBinary } from '@bufbuild/protobuf'
import { TZDate } from '@date-fns/tz'
import * as Ydb from '@ydbjs/api/value'
import { expect, test } from 'vitest'

import {
	Date32,
	Datetime,
	Datetime64,
	DyNumber,
	ExtendedPrimitiveTypeId,
	Interval64,
	Timestamp,
	Timestamp64,
	TzDate,
	TzDate32,
	TzDatetime64,
	TzTimestamp,
	TzTimestamp64,
	Date as YdbDate,
} from './primitive.js'
import { parseTimezoneDate } from './temporal.js'
import type { Value } from './value.js'

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

test('retains Date convenience and exposes exact units for existing time types', () => {
	let date = new Date('1969-12-31T23:59:59.123Z')
	expect(binary(new Date32(date)).value.value).toBe(-1)
	expect(binary(new Datetime64(date)).value.value).toBe(-1n)
	expect(binary(new Timestamp64(date)).value.value).toBe(-877000n)
	expect(binary(new YdbDate(0)).value.value).toBe(0)
	expect(binary(new Datetime(1)).value.value).toBe(1)
	expect(binary(new Timestamp(1n)).value.value).toBe(1n)
	expect(binary(new Interval64(-1)).value.value).toBe(-1n)
})

test('constructs all extended timezone type IDs without relying on protobuf enum names', () => {
	for (let [value, id, text] of [
		[new TzDate32('-1-02-29,UTC'), ExtendedPrimitiveTypeId.TZ_DATE32, '-1-02-29,UTC'],
		[
			new TzDatetime64('10000-01-01T12:34:56,UTC'),
			ExtendedPrimitiveTypeId.TZ_DATETIME64,
			'10000-01-01T12:34:56,UTC',
		],
		[
			new TzTimestamp64('-1-02-29T12:34:56.123456,UTC'),
			ExtendedPrimitiveTypeId.TZ_TIMESTAMP64,
			'-1-02-29T12:34:56.123456,UTC',
		],
	] as const) {
		expect(value.type.encode().type).toEqual({ case: 'typeId', value: id })
		expect(binary(value).value).toEqual({ case: 'textValue', value: text })
	}
})

test('timezone strings preserve exact microseconds and reject incompatible date fields', () => {
	let text = '2025-01-01T12:34:56.000001,Asia/Tokyo'
	expect(binary(new TzTimestamp(text)).value.value).toBe(text)
	for (let createValue of [
		() => new TzDate32('0-01-01,UTC'),
		() => new TzDate32('-2-02-29,UTC'),
		() => new TzDate32('2025-02-30,UTC'),
		() => new TzDatetime64('2025-01-01T24:00:00,UTC'),
		() => new TzDate32('2025-01-01T00:00:00,UTC'),
		() => new TzDatetime64('2025-01-01T00:00:00.1,UTC'),
		() => new TzTimestamp64('2025-01-01,UTC'),
		() => new TzTimestamp64('2025-01-01T00:00:00.0000001,UTC'),
		() => new TzTimestamp64('2025-01-01T00:00:00,Not/A/Timezone'),
		() => new TzDate('-1-01-01,UTC'),
	])
		expect(createValue).toThrow(/YDB|Timezone|timezone/)
})

test('timezone projection maps historical BCE years to astronomical JavaScript years', () => {
	let date = parseTimezoneDate('-1-02-29T12:34:56.123456,UTC')
	expect(date.getFullYear()).toBe(0)
	expect(date.getMonth()).toBe(1)
	expect(date.getDate()).toBe(29)
	expect(date.getHours()).toBe(12)
	expect(date.getMilliseconds()).toBe(123)
	expect(binary(new TzTimestamp64(date)).value.value).toBe('-1-02-29T12:34:56.123000,UTC')
	expect(parseTimezoneDate('1-01-01,UTC').getFullYear()).toBe(1)
	expect(parseTimezoneDate('10000-01-01,UTC').getFullYear()).toBe(10000)
})

test('timezone constructors format the value timezone and extended years directly', () => {
	let date = TZDate.tz('Asia/Tokyo', 10000, 0, 1, 12, 34, 56, 1)
	expect(binary(new TzDate32(date)).value.value).toBe('10000-01-01,Asia/Tokyo')
	expect(binary(new TzDatetime64(date)).value.value).toBe('10000-01-01T12:34:56,Asia/Tokyo')
	expect(binary(new TzTimestamp64(date)).value.value).toBe(
		'10000-01-01T12:34:56.001000,Asia/Tokyo'
	)
})

test('DyNumber construction preserves the decimal text instead of coercing it to number', () => {
	let text = '123456789012345678901234567890.12345678'
	let value = new DyNumber(text)
	expect(value.type.encode().type).toEqual({
		case: 'typeId',
		value: Ydb.Type_PrimitiveTypeId.DYNUMBER,
	})
	expect(binary(value).value).toEqual({ case: 'textValue', value: text })
})
