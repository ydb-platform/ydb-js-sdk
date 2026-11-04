import { install } from 'temporal-polyfill/shim'
import * as Ydb from '@ydbjs/api/value'
import { Temporal } from 'temporal-polyfill'
import { Temporal as ImplementationTemporal } from 'temporal-polyfill/implementation'
import { expect, test } from 'vitest'
import { Date32, Datetime64, Interval64, Timestamp64 } from './primitive.js'

install()

for (let [source, temporal] of [
	['selected', Temporal],
	['implementation', ImplementationTemporal],
] as const) {
	test(`encodes ${source} Temporal inputs with wide constructors`, () => {
		let cases = [
			[
				new Date32(temporal.PlainDate.from('1969-12-31')),
				Ydb.Type_PrimitiveTypeId.DATE32,
				{ case: 'int32Value', value: -1 },
			],
			[
				new Datetime64(temporal.Instant.from('1969-12-31T23:59:59Z')),
				Ydb.Type_PrimitiveTypeId.DATETIME64,
				{ case: 'int64Value', value: -1n },
			],
			[
				new Timestamp64(temporal.Instant.from('1969-12-31T23:59:59.999999Z')),
				Ydb.Type_PrimitiveTypeId.TIMESTAMP64,
				{ case: 'int64Value', value: -1n },
			],
			[
				new Interval64(
					temporal.Duration.from({ seconds: 9_223_339_708_799, microseconds: 999_999 })
				),
				Ydb.Type_PrimitiveTypeId.INTERVAL64,
				{ case: 'int64Value', value: 9_223_339_708_799_999_999n },
			],
		] as const

		for (let [value, id, scalar] of cases) {
			expect(value.type.encode().type).toEqual({ case: 'typeId', value: id })
			expect(value.encode().value).toEqual(scalar)
		}
	})

	test(`rejects calendar and precision loss in ${source} wide Temporal inputs`, () => {
		let date = temporal.PlainDate.from('2025-01-01[u-ca=gregory]')
		let instant = temporal.Instant.from('1970-01-01T00:00:01.000000001Z')
		let duration = temporal.Duration.from({ nanoseconds: 1 })

		expect(() => new Date32(date)).toThrow(/ISO/)
		expect(() => new Timestamp64(instant)).toThrow(/precision/)
		expect(() => new Interval64(duration)).toThrow(/precision/)
		expect(() => new Datetime64(temporal.Instant.from('1970-01-01T00:00:01.000001Z'))).toThrow(
			/precision/
		)
	})
}

test('wide constructors retain Date input compatibility', () => {
	let date = new Date('1970-01-02T00:00:01.123Z')

	expect(new Date32(date).encode().value).toEqual({ case: 'int32Value', value: 1 })
	expect(new Datetime64(date).encode().value).toEqual({ case: 'int64Value', value: 86_401n })
	expect(new Timestamp64(date).encode().value).toEqual({
		case: 'int64Value',
		value: 86_401_123_000n,
	})
})

test('wide constructors reject temporal kinds with unspecified information', () => {
	let dateTime = Temporal.PlainDateTime.from('2025-01-01T12:34:56')
	let zoned = Temporal.ZonedDateTime.from('2025-01-01T12:34:56[Asia/Tokyo]')

	expect(() => new Date32(dateTime as never)).toThrow(/PlainDate/)
	for (let Input of [Timestamp64, Datetime64]) {
		expect(() => new Input(zoned as never)).toThrow(/Instant/)
	}
})
