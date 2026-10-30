import { test } from 'vitest'
import { fromJs, fromYdb, toJs } from './index.ts'
import { Optional, OptionalType } from './optional.ts'
import { Int32, Int32Type } from './primitive.ts'
import { Null } from './null.ts'
import { typeToString } from './print.ts'

test('struct field names remain own data properties through value conversion', (t) => {
	let input = JSON.parse('{"__proto__":{"role":"reader"},"constructor":7}')
	for (let native of [input, [input]]) {
		let value = fromJs(native)
		let direct = toJs(value)
		let decoded = toJs(fromYdb(value.encode(), value.type.encode()))
		t.expect(direct).toStrictEqual(native)
		t.expect(decoded).toStrictEqual(native)
		let row = Array.isArray(decoded) ? decoded[0] : decoded
		t.expect(Object.getPrototypeOf(row)).toBe(Object.prototype)
		t.expect(Object.hasOwn(row as object, '__proto__')).toBe(true)
	}
	let inherited = Object.assign(Object.create({ inherited: 1 }), { own: 2 })
	t.expect(toJs(fromJs([inherited]))).toEqual([{ own: 2 }])
})

test('nested optional values preserve presence on the wire and decode to native values', (t) => {
	let scalarType = new Int32Type()
	let innerNull = new Optional(null, scalarType)
	let outerNull = new Optional(null, new OptionalType(scalarType))
	let presentNull = new Optional(innerNull)
	let presentScalar = new Optional(new Optional(new Int32(42)))
	t.expect(outerNull.encode().value).toEqual(new Null().encode().value)
	t.expect(presentNull.encode().value).toMatchObject({
		case: 'nestedValue',
		value: { value: { case: 'nullFlagValue' } },
	})
	t.expect(presentScalar.encode().value).toEqual(new Int32(42).encode().value)
	for (let [value, expected] of [
		[outerNull, null],
		[presentNull, null],
		[presentScalar, 42],
	] as const) {
		t.expect(toJs(fromYdb(value.encode(), value.type.encode()))).toBe(expected)
	}
	let thirdLevel = new Optional(presentNull)
	t.expect(thirdLevel.encode().value).toMatchObject({
		case: 'nestedValue',
		value: { value: { case: 'nestedValue', value: { value: { case: 'nullFlagValue' } } } },
	})
	t.expect(toJs(fromYdb(thirdLevel.encode(), thirdLevel.type.encode()))).toBeNull()
})

test('transforms fromJs with primitives', async (t) => {
	let boolVal = fromJs(true)
	let numVal = fromJs(42)
	let strVal = fromJs('hello')

	t.expect(boolVal).toMatchInlineSnapshot(`
		Bool {
		  "type": BoolType {},
		  "value": true,
		}
	`)
	t.expect(numVal).toMatchInlineSnapshot(`
		Int32 {
		  "type": Int32Type {},
		  "value": 42,
		}
	`)
	t.expect(strVal).toMatchInlineSnapshot(`
		Text {
		  "type": TextType {},
		  "value": "hello",
		}
	`)
})

test('fromJs with arrays', async (t) => {
	let arrVal = fromJs([1, 2, 3])

	t.expect(arrVal).toMatchInlineSnapshot(`
		List {
		  "items": [
		    Int32 {
		      "type": Int32Type {},
		      "value": 1,
		    },
		    Int32 {
		      "type": Int32Type {},
		      "value": 2,
		    },
		    Int32 {
		      "type": Int32Type {},
		      "value": 3,
		    },
		  ],
		  "type": ListType {
		    "item": Int32Type {},
		  },
		}
	`)
})

test('fromJs with objects', async (t) => {
	let objVal = fromJs({ a: 1, b: 'test' })

	t.expect(objVal).toMatchInlineSnapshot(`
		Struct {
		  "items": [
		    Int32 {
		      "type": Int32Type {},
		      "value": 1,
		    },
		    Text {
		      "type": TextType {},
		      "value": "test",
		    },
		  ],
		  "type": StructType {
		    "names": [
		      "a",
		      "b",
		    ],
		    "types": [
		      Int32Type {},
		      TextType {},
		    ],
		  },
		}
	`)
})

test('fromJs with null', async (t) => {
	let nullVal = fromJs(null)

	t.expect(nullVal).toMatchInlineSnapshot(`
		Null {
		  "type": NullType {},
		}
	`)
})

test('transforms toJs with primitives', async (t) => {
	let boolVal = toJs(fromJs(true))
	let numVal = toJs(fromJs(42))
	let strVal = toJs(fromJs('hello'))

	t.expect(boolVal).toMatchInlineSnapshot(`true`)
	t.expect(numVal).toMatchInlineSnapshot(`42`)
	t.expect(strVal).toMatchInlineSnapshot(`"hello"`)
})

test('toJs with arrays', async (t) => {
	let arrVal = toJs(fromJs([1, 2, 3]))

	t.expect(arrVal).toMatchInlineSnapshot(`
		[
		  1,
		  2,
		  3,
		]
	`)
})

test('toJs with objects', async (t) => {
	let objVal = toJs(fromJs({ a: 1, b: 'test' }))

	t.expect(objVal).toMatchInlineSnapshot(`
		{
		  "a": 1,
		  "b": "test",
		}
	`)
})

test('toJs with null', async (t) => {
	let nullVal = toJs(fromJs(null))

	t.expect(nullVal).toMatchInlineSnapshot(`null`)
})

test('fromJs with array of objects with different fields', async (t) => {
	let arrVal = fromJs([{ name: 'Test' }, { age: 99 }])

	t.expect(typeToString(arrVal.type)).toMatchInlineSnapshot(
		`"List<Struct<age:Optional<Int32>,name:Optional<Utf8>>>"`
	)

	t.expect(arrVal).toMatchInlineSnapshot(`
		List {
		  "items": [
		    Struct {
		      "items": [
		        Optional {
		          "item": null,
		          "type": OptionalType {
		            "itemType": Int32Type {},
		          },
		        },
		        Optional {
		          "item": Text {
		            "type": TextType {},
		            "value": "Test",
		          },
		          "type": OptionalType {
		            "itemType": TextType {},
		          },
		        },
		      ],
		      "type": StructType {
		        "names": [
		          "age",
		          "name",
		        ],
		        "types": [
		          OptionalType {
		            "itemType": Int32Type {},
		          },
		          OptionalType {
		            "itemType": TextType {},
		          },
		        ],
		      },
		    },
		    Struct {
		      "items": [
		        Optional {
		          "item": Int32 {
		            "type": Int32Type {},
		            "value": 99,
		          },
		          "type": OptionalType {
		            "itemType": Int32Type {},
		          },
		        },
		        Optional {
		          "item": null,
		          "type": OptionalType {
		            "itemType": TextType {},
		          },
		        },
		      ],
		      "type": StructType {
		        "names": [
		          "age",
		          "name",
		        ],
		        "types": [
		          OptionalType {
		            "itemType": Int32Type {},
		          },
		          OptionalType {
		            "itemType": TextType {},
		          },
		        ],
		      },
		    },
		  ],
		  "type": ListType {
		    "item": StructType {
		      "names": [
		        "age",
		        "name",
		      ],
		      "types": [
		        OptionalType {
		          "itemType": Int32Type {},
		        },
		        OptionalType {
		          "itemType": TextType {},
		        },
		      ],
		    },
		  },
		}
	`)
})

test('toJs with array of objects with different fields', async (t) => {
	let arrVal = toJs(fromJs([{ name: 'Test' }, { age: 99 }]))

	t.expect(arrVal).toMatchInlineSnapshot(`
		[
		  {
		    "age": null,
		    "name": "Test",
		  },
		  {
		    "age": 99,
		    "name": null,
		  },
		]
	`)
})
