import { test } from 'vitest'
import { Bool, Bytes, Date, Datetime, Double, Int32, Int64, Text, Timestamp, Uint32, Uint64 } from '../dist/esm/primitive.js'

test('Bool primitive', async (tc) => {
	const boolTrue = new Bool(true)
	const boolFalse = new Bool(false)

	tc.expect(boolTrue).toMatchInlineSnapshot(`
		Bool {
		  "type": BoolType {},
		  "value": true,
		}
	`)
	tc.expect(boolFalse).toMatchInlineSnapshot(`
		Bool {
		  "type": BoolType {},
		  "value": false,
		}
	`)
})

test('Int32 primitive', async (tc) => {
	const int = new Int32(42)

	tc.expect(int).toMatchInlineSnapshot(`
		Int32 {
		  "type": Int32Type {},
		  "value": 42,
		}
	`)
})

test('Uint32 primitive', async (tc) => {
	const uint = new Uint32(42)

	tc.expect(uint).toMatchInlineSnapshot(`
		Uint32 {
		  "type": Uint32Type {},
		  "value": 42,
		}
	`)
})

test('Text primitive', async (tc) => {
	const text = new Text('hello')

	tc.expect(text).toMatchInlineSnapshot(`
		Text {
		  "type": TextType {},
		  "value": "hello",
		}
	`)
})

test('Double primitive', async (tc) => {
	const double = new Double(3.14)

	tc.expect(double).toMatchInlineSnapshot(`
		Double {
		  "type": DoubleType {},
		  "value": 3.14,
		}
	`)
})

test('Bytes primitive', async (tc) => {
	const bytes = new Bytes(new Uint8Array([0x01, 0x02, 0x03]))

	tc.expect(bytes).toMatchInlineSnapshot(`
		Bytes {
		  "type": BytesType {},
		  "value": Uint8Array [
		    1,
		    2,
		    3,
		  ],
		}
	`)
})

test('Int64 primitive', async (tc) => {
	const int64 = new Int64(9007199254740991n)

	tc.expect(int64).toMatchInlineSnapshot(`
		Int64 {
		  "type": Int64Type {},
		  "value": 9007199254740991n,
		}
	`)
})

test('Uint64 primitive', async (tc) => {
	const uint64 = new Uint64(9007199254740991n)

	tc.expect(uint64).toMatchInlineSnapshot(`
		Uint64 {
		  "type": Uint64Type {},
		  "value": 9007199254740991n,
		}
	`)
})

test('Date primitive', async (tc) => {
	const date = new Date(new globalThis.Date('2025-01-01'))

	tc.expect(date).toMatchInlineSnapshot(`
		Date {
		  "type": DateType {},
		  "value": 20089,
		}
	`)
})

test('Datetime primitive', async (tc) => {
	const datetime = new Datetime(new globalThis.Date('2025-01-01T00:00:00Z'))

	tc.expect(datetime).toMatchInlineSnapshot(`
		Datetime {
		  "type": DatetimeType {},
		  "value": 1735689600,
		}
	`)
})

test('Timestamp primitive', async (tc) => {
	const timestamp = new Timestamp(new globalThis.Date('2025-01-01T00:00:00Z'))

	tc.expect(timestamp).toMatchInlineSnapshot(`
		Timestamp {
		  "type": TimestampType {},
		  "value": 1735689600000000n,
		}
	`)
})
