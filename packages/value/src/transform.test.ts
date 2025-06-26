import { test } from 'vitest'
import { fromJs, toJs } from '../dist/esm/index.js'

test('fromJs with primitives', async (t) => {
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

test('toJs with primitives', async (t) => {
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

	t.expect(arrVal).toMatchInlineSnapshot(`
		List {
		  "items": [
		    Struct {
		      "items": [
		        Optional {
		          "item": null,
		          "type": OptionalType {
		            "itemType": OptionalType {
		              "itemType": Int32Type {},
		            },
		          },
		        },
		        Optional {
		          "item": Optional {
		            "item": Text {
		              "type": TextType {},
		              "value": "Test",
		            },
		            "type": OptionalType {
		              "itemType": TextType {},
		            },
		          },
		          "type": OptionalType {
		            "itemType": OptionalType {
		              "itemType": TextType {},
		            },
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
		          "item": Optional {
		            "item": Int32 {
		              "type": Int32Type {},
		              "value": 99,
		            },
		            "type": OptionalType {
		              "itemType": Int32Type {},
		            },
		          },
		          "type": OptionalType {
		            "itemType": OptionalType {
		              "itemType": Int32Type {},
		            },
		          },
		        },
		        Optional {
		          "item": null,
		          "type": OptionalType {
		            "itemType": OptionalType {
		              "itemType": TextType {},
		            },
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
