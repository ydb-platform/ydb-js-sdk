import { Type_PrimitiveTypeId } from '@ydbjs/api/value'
import { afterEach, expect, test, vi } from 'vitest'
import { fromJs, toJs } from './index.js'
import { Primitive, PrimitiveType, Timestamp, TzTimestamp, TzTimestampType } from './primitive.js'

afterEach(() => vi.unstubAllGlobals())

test('default conversion works without a Temporal implementation', () => {
	vi.stubGlobal('Temporal', undefined)
	let timestamp = new Timestamp(1_234_567n)
	expect(toJs(timestamp)).toEqual(new Date(1234))
	expect([timestamp].map(toJs)).toEqual([new Date(1234)])
	expect(toJs(fromJs(new Date(1000)))).toEqual(new Date(1000))
	let date = new Primitive(
		{ value: { case: 'int32Value', value: -1 } },
		new PrimitiveType(Type_PrimitiveTypeId.DATE32)
	)
	expect(toJs(date)).toBe(date)
	let zoned = new Primitive(
		{ value: { case: 'textValue', value: '2025-01-01T00:00:00.123456,UTC' } },
		new TzTimestampType()
	)
	expect(toJs(zoned)).toBe(zoned)
})

test('timezone constructors require Temporal even for string input', () => {
	vi.stubGlobal('Temporal', undefined)
	expect(() => new TzTimestamp('2025-01-01T00:00:00.123456,UTC')).toThrow(
		/Temporal is not available.*application/
	)
})

test('Temporal result conversion requires an application implementation', () => {
	vi.stubGlobal('Temporal', undefined)

	expect(() => toJs(new Timestamp(0n), { temporal: true })).toThrow(
		/Temporal is not available.*application/
	)
})

test('conversion rejects invalid runtime mode options', () => {
	let value = new Timestamp(0n)
	expect(() => toJs(value, { temporal: 'false' } as never)).toThrow(/boolean/)
	expect(() => toJs(value, { temporal: null } as never)).toThrow(/boolean/)
	for (let options of [null, true, [], 'temporal'])
		expect(() => toJs(value, options as never)).toThrow(/options must be an object/)
})
