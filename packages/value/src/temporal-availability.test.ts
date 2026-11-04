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
