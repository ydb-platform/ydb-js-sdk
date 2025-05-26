import { test } from 'vitest'
import {
	Bool,
	Bytes,
	Date,
	Datetime,
	Double,
	Int32,
	Int64,
	Text,
	Timestamp,
	Uint32,
	Uint64,
	Uuid,
} from '../dist/esm/primitive.js'

test('Bool primitive', async (t) => {
	const boolTrue = new Bool(true)
	const boolFalse = new Bool(false)

	t.expect(boolTrue).toMatchInlineSnapshot(`
		Bool {
		  "type": BoolType {},
		  "value": true,
		}
	`)
	t.expect(boolFalse).toMatchInlineSnapshot(`
		Bool {
		  "type": BoolType {},
		  "value": false,
		}
	`)
})

test('Int32 primitive', async (t) => {
	const int = new Int32(42)

	t.expect(int).toMatchInlineSnapshot(`
		Int32 {
		  "type": Int32Type {},
		  "value": 42,
		}
	`)
})

test('Uint32 primitive', async (t) => {
	const uint = new Uint32(42)

	t.expect(uint).toMatchInlineSnapshot(`
		Uint32 {
		  "type": Uint32Type {},
		  "value": 42,
		}
	`)
})

test('Text primitive', async (t) => {
	const text = new Text('hello')

	t.expect(text).toMatchInlineSnapshot(`
		Text {
		  "type": TextType {},
		  "value": "hello",
		}
	`)
})

test('Double primitive', async (t) => {
	const double = new Double(3.14)

	t.expect(double).toMatchInlineSnapshot(`
		Double {
		  "type": DoubleType {},
		  "value": 3.14,
		}
	`)
})

test('Bytes primitive', async (t) => {
	const bytes = new Bytes(new Uint8Array([0x01, 0x02, 0x03]))

	t.expect(bytes).toMatchInlineSnapshot(`
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

test('Int64 primitive', async (t) => {
	const int64 = new Int64(9007199254740991n)

	t.expect(int64).toMatchInlineSnapshot(`
		Int64 {
		  "type": Int64Type {},
		  "value": 9007199254740991n,
		}
	`)
})

test('Uint64 primitive', async (t) => {
	const uint64 = new Uint64(9007199254740991n)

	t.expect(uint64).toMatchInlineSnapshot(`
		Uint64 {
		  "type": Uint64Type {},
		  "value": 9007199254740991n,
		}
	`)
})

test('Date primitive', async (t) => {
	const date = new Date(new globalThis.Date('2025-01-01'))

	t.expect(date).toMatchInlineSnapshot(`
		Date {
		  "type": DateType {},
		  "value": 20089,
		}
	`)
})

test('Datetime primitive', async (t) => {
	const datetime = new Datetime(new globalThis.Date('2025-01-01T00:00:00Z'))

	t.expect(datetime).toMatchInlineSnapshot(`
		Datetime {
		  "type": DatetimeType {},
		  "value": 1735689600,
		}
	`)
})

test('Timestamp primitive', async (t) => {
	const timestamp = new Timestamp(new globalThis.Date('2025-01-01T00:00:00Z'))

	t.expect(timestamp).toMatchInlineSnapshot(`
		Timestamp {
		  "type": TimestampType {},
		  "value": 1735689600000000n,
		}
	`)
})

test('UUID primitive', async (t) => {
	const uuid = new Uuid('00112233-4455-6677-8899-aabbccddeeff')

	t.expect(uuid).toMatchInlineSnapshot(`
		Uuid {
		  "high128": 18441921395520346504n,
		  "low128": 7383445245961249331n,
		  "type": UuidType {},
		  "value": 7383445245961249331n,
		}
	`)

	t.expect(uuid.toString()).toBe('00112233-4455-6677-8899-aabbccddeeff')
})
