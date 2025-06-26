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

test('creates Bool primitive', async (t) => {
	let boolTrue = new Bool(true)
	let boolFalse = new Bool(false)

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

test('creates Int32 primitive', async (t) => {
	let int = new Int32(42)

	t.expect(int).toMatchInlineSnapshot(`
		Int32 {
		  "type": Int32Type {},
		  "value": 42,
		}
	`)
})

test('creates Uint32 primitive', async (t) => {
	let uint = new Uint32(42)

	t.expect(uint).toMatchInlineSnapshot(`
		Uint32 {
		  "type": Uint32Type {},
		  "value": 42,
		}
	`)
})

test('creates Text primitive', async (t) => {
	let text = new Text('hello')

	t.expect(text).toMatchInlineSnapshot(`
		Text {
		  "type": TextType {},
		  "value": "hello",
		}
	`)
})

test('creates Double primitive', async (t) => {
	let double = new Double(3.14)

	t.expect(double).toMatchInlineSnapshot(`
		Double {
		  "type": DoubleType {},
		  "value": 3.14,
		}
	`)
})

test('creates Bytes primitive', async (t) => {
	let bytes = new Bytes(new Uint8Array([0x01, 0x02, 0x03]))

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

test('creates Int64 primitive', async (t) => {
	let int64 = new Int64(9007199254740991n)

	t.expect(int64).toMatchInlineSnapshot(`
		Int64 {
		  "type": Int64Type {},
		  "value": 9007199254740991n,
		}
	`)
})

test('creates Uint64 primitive', async (t) => {
	let uint64 = new Uint64(9007199254740991n)

	t.expect(uint64).toMatchInlineSnapshot(`
		Uint64 {
		  "type": Uint64Type {},
		  "value": 9007199254740991n,
		}
	`)
})

test('creates Date primitive', async (t) => {
	let date = new Date(new globalThis.Date('2025-01-01'))

	t.expect(date).toMatchInlineSnapshot(`
		Date {
		  "type": DateType {},
		  "value": 20089,
		}
	`)
})

test('creates Datetime primitive', async (t) => {
	let datetime = new Datetime(new globalThis.Date('2025-01-01T00:00:00Z'))

	t.expect(datetime).toMatchInlineSnapshot(`
		Datetime {
		  "type": DatetimeType {},
		  "value": 1735689600,
		}
	`)
})

test('creates Timestamp primitive', async (t) => {
	let timestamp = new Timestamp(new globalThis.Date('2025-01-01T00:00:00Z'))

	t.expect(timestamp).toMatchInlineSnapshot(`
		Timestamp {
		  "type": TimestampType {},
		  "value": 1735689600000000n,
		}
	`)
})

test('creates UUID primitive', async (t) => {
	let uuid = new Uuid('00112233-4455-6677-8899-aabbccddeeff')

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
