import { install } from 'temporal-polyfill/shim'
import { fromBinary, toBinary } from '@bufbuild/protobuf'
import * as Ydb from '@ydbjs/api/value'
import { Temporal } from 'temporal-polyfill'
import { expect, test } from 'vitest'
import {
	ExtendedPrimitiveTypeId,
	TzDate,
	TzDate32,
	TzDatetime64,
	TzTimestamp,
	TzTimestamp64,
} from './primitive.js'
import { fromYdb, toJs } from './index.js'
import type { Value } from './value.js'

install()

function binary(value: Value): Ydb.Value {
	return fromBinary(Ydb.ValueSchema, toBinary(Ydb.ValueSchema, value.encode()))
}

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
		let wire = binary(value)
		let decoded = fromYdb(wire, value.type.encode())

		expect(value.type.encode().type).toEqual({ case: 'typeId', value: id })
		expect(wire.value).toEqual({ case: 'textValue', value: text })
		expect(decoded.type.encode()).toEqual(value.type.encode())
		expect(decoded.encode()).toEqual(wire)
		expect(toJs(decoded)).toBe(decoded)
	}
})

test('timezone strings preserve exact microseconds and reject incompatible date fields', () => {
	let text = '2025-01-01T12:34:56.000001,Asia/Tokyo'
	expect(binary(new TzTimestamp(text)).value.value).toBe(text)
	let invalid: [() => unknown, typeof Error][] = [
		[() => new TzDate32('0-01-01,UTC'), RangeError],
		[() => new TzDate32('-2-02-29,UTC'), RangeError],
		[() => new TzDate32('2025-02-30,UTC'), RangeError],
		[() => new TzDatetime64('2025-01-01T24:00:00,UTC'), RangeError],
		[() => new TzDate32('2025-01-01T00:00:00,UTC'), TypeError],
		[() => new TzDatetime64('2025-01-01T00:00:00.1,UTC'), TypeError],
		[() => new TzTimestamp64('2025-01-01,UTC'), TypeError],
		[() => new TzTimestamp64('2025-01-01T00:00:00.0000001,UTC'), TypeError],
		[() => new TzTimestamp64('2025-01-01T00:00:00,Not/A/Timezone'), RangeError],
		[() => new TzDate('-1-01-01,UTC'), RangeError],
	]
	for (let [createValue, error] of invalid) expect(createValue).toThrow(error)
})

test('timezone constructors format the value timezone and extended years directly', () => {
	let date = Temporal.ZonedDateTime.from('+010000-01-01T12:34:56.001[Asia/Tokyo]')
	expect(binary(new TzDate32(date)).value.value).toBe('10000-01-01,Asia/Tokyo')
	expect(binary(new TzDatetime64(date.with({ millisecond: 0 }))).value.value).toBe(
		'10000-01-01T12:34:56,Asia/Tokyo'
	)
	expect(binary(new TzTimestamp64(date)).value.value).toBe(
		'10000-01-01T12:34:56.001000,Asia/Tokyo'
	)
})
