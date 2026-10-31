import { fromBinary, toBinary } from '@bufbuild/protobuf'
import { TZDate } from '@date-fns/tz'
import * as Ydb from '@ydbjs/api/value'
import { test } from 'vitest'

import { fromJs, fromYdb, toJs } from './index.js'
import { Interval, TzTimestamp } from './primitive.js'

test('encodes Interval microseconds as signed 64-bit values', (t) => {
	for (let microseconds of [
		0,
		1,
		-1,
		2 ** 32,
		-(2 ** 32),
		4_291_747_199_999_999,
		-4_291_747_199_999_999,
	]) {
		let value = new Interval(microseconds)
		let wire = fromBinary(Ydb.ValueSchema, toBinary(Ydb.ValueSchema, value.encode()))

		t.expect(value.value).toBe(microseconds)
		t.expect(value.type.encode().type).toEqual({
			case: 'typeId',
			value: Ydb.Type_PrimitiveTypeId.INTERVAL,
		})
		t.expect(wire.value).toEqual({ case: 'int64Value', value: BigInt(microseconds) })
	}
})

test('rejects Interval inputs that cannot represent exact microseconds', (t) => {
	for (let microseconds of [0.5, -0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
		t.expect(() => new Interval(microseconds)).toThrow(
			'Interval must be a safe integer number of microseconds'
		)
	}
})

test('encodes TzTimestamp fractions with their original millisecond precision', (t) => {
	for (let milliseconds of [0, 1, 10, 99, 100, 999]) {
		let date = TZDate.tz('UTC', 2025, 0, 1, 12, 34, 56, milliseconds)
		let value = new TzTimestamp(date)
		let wire = fromBinary(Ydb.ValueSchema, toBinary(Ydb.ValueSchema, value.encode()))

		t.expect(wire.value).toEqual({
			case: 'textValue',
			value: `2025-01-01T12:34:56.${String(milliseconds).padStart(3, '0')}000,UTC`,
		})
	}
})

test('encodes TzTimestamp using the value timezone', (t) => {
	let date = TZDate.tz('Asia/Tokyo', 2025, 0, 1, 0, 0, 0, 1)
	let wire = new TzTimestamp(date).encode()

	t.expect(wire.value).toEqual({
		case: 'textValue',
		value: '2025-01-01T00:00:00.001000,Asia/Tokyo',
	})
})

test('preserves Float64Array precision through protobuf binary serialization', (t) => {
	let value = fromJs(new Float64Array([16777217]) as never)
	let wire = fromBinary(Ydb.ValueSchema, toBinary(Ydb.ValueSchema, value.encode()))
	t.expect(wire.items[0]!.value).toEqual({ case: 'doubleValue', value: 16777217 })
	t.expect(toJs(fromYdb(wire, value.type.encode()))).toEqual([16777217])
})
