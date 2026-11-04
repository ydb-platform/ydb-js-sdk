import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import * as Ydb from '@ydbjs/api/value'
import { expect, test } from 'vitest'
import { fromYdb, toJs } from './index.js'
import { typeToString } from './print.js'

test('rejects invalid Decimal words before signed conversion can discard their bits', () => {
	let type = create(Ydb.TypeSchema, {
		type: { case: 'decimalType', value: { precision: 22, scale: 9 } },
	})

	for (let [low, high] of [
		[-1n, 0n],
		[0n, -1n],
		[1n << 64n, 0n],
		[0n, 1n << 64n],
	] as const) {
		let wire = create(Ydb.ValueSchema)
		wire.value = { case: 'low128', value: low }
		wire.high128 = high

		expect(() => fromYdb(wire, type)).toThrow(/uint64 range/)
	}
})

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
