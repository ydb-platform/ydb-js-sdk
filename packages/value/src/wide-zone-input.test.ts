import { install } from 'temporal-polyfill/shim'
import { Temporal } from 'temporal-polyfill'
import { Temporal as ImplementationTemporal } from 'temporal-polyfill/implementation'
import { expect, test } from 'vitest'
import { ExtendedPrimitiveTypeId, TzDate32, TzDatetime64, TzTimestamp64 } from './primitive.js'

install()

for (let [source, temporal] of [
	['selected', Temporal],
	['implementation', ImplementationTemporal],
] as const) {
	test(`encodes ${source} Temporal inputs with extended timezone constructors`, () => {
		let ancient = temporal.ZonedDateTime.from('0000-02-29T12:34:56.000001[UTC]')
		let cases = [
			[new TzDate32(ancient), ExtendedPrimitiveTypeId.TZ_DATE32, '-1-02-29,UTC'],
			[
				new TzDatetime64(ancient.with({ microsecond: 0 })),
				ExtendedPrimitiveTypeId.TZ_DATETIME64,
				'-1-02-29T12:34:56,UTC',
			],
			[
				new TzTimestamp64(ancient),
				ExtendedPrimitiveTypeId.TZ_TIMESTAMP64,
				'-1-02-29T12:34:56.000001,UTC',
			],
		] as const

		for (let [value, id, text] of cases) {
			expect(value.type.encode().type).toEqual({ case: 'typeId', value: id })
			expect(value.encode().value).toEqual({ case: 'textValue', value: text })
		}
	})

	test(`rejects calendar and precision loss in ${source} extended timezone inputs`, () => {
		let nonISO = temporal.ZonedDateTime.from('2025-01-01T00:00:00[UTC][u-ca=gregory]')
		let nanos = temporal.Instant.from('1970-01-01T00:00:01.000000001Z').toZonedDateTimeISO(
			'UTC'
		)
		let micros = temporal.Instant.from('1970-01-01T00:00:01.000001Z').toZonedDateTimeISO('UTC')

		expect(() => new TzTimestamp64(nonISO)).toThrow(/ISO/)
		expect(() => new TzTimestamp64(nanos)).toThrow(/precision/)
		expect(() => new TzDatetime64(micros)).toThrow(/precision/)
	})
}
