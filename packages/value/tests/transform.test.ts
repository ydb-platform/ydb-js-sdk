import { test } from 'vitest'
import { fromJs, toJs } from '../dist/esm/index.js'

test('fromJs with primitives', async (tc) => {
	const boolVal = fromJs(true)
	const numVal = fromJs(42)
	const strVal = fromJs('hello')

	tc.expect(boolVal).toMatchInlineSnapshot(`
		Bool {
		  "type": BoolType {},
		  "value": true,
		}
	`)
	tc.expect(numVal).toMatchInlineSnapshot(`
		Int32 {
		  "type": Int32Type {},
		  "value": 42,
		}
	`)
	tc.expect(strVal).toMatchInlineSnapshot(`
		Text {
		  "type": TextType {},
		  "value": "hello",
		}
	`)
})

test('fromJs with arrays', async (tc) => {
	const arrVal = fromJs([1, 2, 3])
	tc.expect(arrVal).toMatchInlineSnapshot(`
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

test('fromJs with objects', async (tc) => {
	const objVal = fromJs({ a: 1, b: 'test' })
	tc.expect(objVal).toMatchInlineSnapshot(`
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

test('fromJs with null', async (tc) => {
	const nullVal = fromJs(null)
	tc.expect(nullVal).toMatchInlineSnapshot(`
		Null {
		  "type": NullType {},
		}
	`)
})

test('toJs with primitives', async (tc) => {
	const boolVal = toJs(fromJs(true))
	const numVal = toJs(fromJs(42))
	const strVal = toJs(fromJs('hello'))

	tc.expect(boolVal).toMatchInlineSnapshot(`true`)
	tc.expect(numVal).toMatchInlineSnapshot(`42`)
	tc.expect(strVal).toMatchInlineSnapshot(`"hello"`)
})

test('toJs with arrays', async (tc) => {
	const arrVal = toJs(fromJs([1, 2, 3]))
	tc.expect(arrVal).toMatchInlineSnapshot(`
		[
		  1,
		  2,
		  3,
		]
	`)
})

test('toJs with objects', async (tc) => {
	const objVal = toJs(fromJs({ a: 1, b: 'test' }))
	tc.expect(objVal).toMatchInlineSnapshot(`
		{
		  "a": 1,
		  "b": "test",
		}
	`)
})

test('toJs with null', async (tc) => {
	const nullVal = toJs(fromJs(null))
	tc.expect(nullVal).toMatchInlineSnapshot(`null`)
})

test('fromJs with array of objects with different fields', async (tc) => {
	const arrVal = fromJs([{ name: 'Test' }, { age: 99 }])
	tc.expect(arrVal).toMatchInlineSnapshot(`
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

test('toJs with array of objects with different fields', async (tc) => {
	const arrVal = toJs(fromJs([{ name: 'Test' }, { age: 99 }]))
	tc.expect(arrVal).toMatchInlineSnapshot(`
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
