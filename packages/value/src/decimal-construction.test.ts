import { fromBinary, toBinary } from '@bufbuild/protobuf'
import * as Ydb from '@ydbjs/api/value'
import { expect, test } from 'vitest'

import { Decimal, DecimalType } from './decimal.js'
import { EmptyDict, EmptyDictType, EmptyList, EmptyListType, EmptyType } from './empty.js'
import { fromYdb } from './index.js'

for (let [text, scaled, canonical] of [
	['123.4500', 12345n, '123.45'],
	['-0.01', -1n, '-0.01'],
	['+.5', 50n, '0.5'],
	['1.', 100n, '1'],
	['-0.000', 0n, '0'],
	['0001.23000', 123n, '1.23'],
] as const) {
	test(`constructs Decimal from exact text ${text}`, () => {
		let type = new DecimalType(10, 2)
		let value = new Decimal(text, type)
		let expected = new Decimal(scaled, type)
		let wire = fromBinary(Ydb.ValueSchema, toBinary(Ydb.ValueSchema, value.encode()))
		expect(value.value).toBe(scaled)
		expect(value.toString()).toBe(canonical)
		expect(wire).toEqual(expected.encode())
		expect(fromYdb(wire, type.encode()).type.encode()).toEqual(type.encode())
		expect(fromYdb(wire, type.encode()).encode()).toEqual(wire)
	})
}

test('Decimal text accepts the full finite precision without becoming an infinity sentinel', () => {
	let type = new DecimalType(35, 0)
	let max = '9'.repeat(35)
	expect(new Decimal(max, type).value).toBe(10n ** 35n - 1n)
	expect(new Decimal('-' + max, type).value).toBe(-(10n ** 35n - 1n))
	expect(() => new Decimal('1' + '0'.repeat(35), type)).toThrow(/precision/)
	let tiny = new DecimalType(35, 35)
	expect(new Decimal('0.' + '0'.repeat(34) + '1', tiny).value).toBe(1n)
	expect(() => new Decimal('1', tiny)).toThrow(/precision/)
})

test('Decimal rejects rounding, numeric input and malformed decimal text', () => {
	let type = new DecimalType(5, 2)
	for (let text of ['1.001', '-0.0001', '1.23001']) {
		expect(() => new Decimal(text, type)).toThrow(/rounding/)
	}
	for (let text of ['', '.', '+', '-', '1e2', ' 1', '1 ', '1.2.3', '--1', 'NaN!']) {
		expect(() => new Decimal(text, type)).toThrow(/Decimal/)
	}
	expect(() => new Decimal(1.23 as never, type)).toThrow(/exact decimal text or a scaled bigint/)
	expect(() => new Decimal('1000', type)).toThrow(/precision/)
})

test('Decimal padding does not require an unbounded bigint or lossy coercion', () => {
	let type = new DecimalType(5, 2)
	let padded = '0'.repeat(1000) + '1.23' + '0'.repeat(1000)
	expect(new Decimal(padded, type).value).toBe(123n)
	expect(() => new Decimal(padded + '1', type)).toThrow(/rounding/)
})

test('Decimal special text matches the existing signed 128-bit sentinels', () => {
	let type = new DecimalType(22, 9)
	for (let [text, expected, canonical] of [
		['inf', 10n ** 35n, 'inf'],
		['+INF', 10n ** 35n, 'inf'],
		['-Inf', -(10n ** 35n), '-inf'],
		['nan', 10n ** 35n + 1n, 'nan'],
		['-NaN', 10n ** 35n + 1n, 'nan'],
	] as const) {
		let value = new Decimal(text, type)
		expect(value.value).toBe(expected)
		expect(value.toString()).toBe(canonical)
		expect(value.encode()).toEqual(new Decimal(expected, type).encode())
	}
})

test('named empty constructors preserve their distinct protocol types', () => {
	for (let [value, type, name] of [
		[new EmptyList(), new EmptyListType(), 'emptyListType'],
		[new EmptyDict(), new EmptyDictType(), 'emptyDictType'],
	] as const) {
		expect(value.type.encode()).toEqual(type.encode())
		expect(value.type.encode().type).toEqual({ case: name, value: 0 })
		let wire = fromBinary(Ydb.ValueSchema, toBinary(Ydb.ValueSchema, value.encode()))
		expect(wire.value.case).toBeUndefined()
		expect(wire.items).toEqual([])
		expect(wire.pairs).toEqual([])
		expect(fromYdb(wire, type.encode()).type.encode()).toEqual(type.encode())
	}
	expect(() => new EmptyType(0 as never)).toThrow('EmptyType requires EmptyList or EmptyDict')
})
