import { test } from 'vitest'

import { Bool, Int32, Text } from './primitive.js'
import { Tuple } from './tuple.js'

test('creates empty tuple', async (t) => {
	let tuple = new Tuple()

	t.expect(tuple).toMatchInlineSnapshot(`
		Tuple {
		  "items": [],
		  "type": TupleType {
		    "elements": [],
		  },
		}
	`)
})

test('creates tuple of heterogeneous items', async (t) => {
	let tuple = new Tuple(new Int32(1), new Text('a'), new Bool(true))

	t.expect(tuple).toMatchInlineSnapshot(`
		Tuple {
		  "items": [
		    Int32 {
		      "type": Int32Type {},
		      "value": 1,
		    },
		    Text {
		      "type": TextType {},
		      "value": "a",
		    },
		    Bool {
		      "type": BoolType {},
		      "value": true,
		    },
		  ],
		  "type": TupleType {
		    "elements": [
		      Int32Type {},
		      TextType {},
		      BoolType {},
		    ],
		  },
		}
	`)
})

test('iterates over items in order', async (t) => {
	let tuple = new Tuple(new Int32(1), new Text('a'))

	let collected: unknown[] = []
	for (let item of tuple) {
		collected.push(item)
	}

	t.expect(collected).toHaveLength(2)
	t.expect(collected[0]).toBeInstanceOf(Int32)
	t.expect(collected[1]).toBeInstanceOf(Text)
})

test('encodes element types to protobuf', async (t) => {
	let tuple = new Tuple(new Int32(1), new Text('a'))

	t.expect(tuple.type.encode()).toMatchInlineSnapshot(`
		{
		  "$typeName": "Ydb.Type",
		  "type": {
		    "case": "tupleType",
		    "value": {
		      "$typeName": "Ydb.TupleType",
		      "elements": [
		        {
		          "$typeName": "Ydb.Type",
		          "type": {
		            "case": "typeId",
		            "value": 1,
		          },
		        },
		        {
		          "$typeName": "Ydb.Type",
		          "type": {
		            "case": "typeId",
		            "value": 4608,
		          },
		        },
		      ],
		    },
		  },
		}
	`)
})

test('encodes items to protobuf value', async (t) => {
	let tuple = new Tuple(new Int32(1), new Text('a'))

	t.expect(tuple.encode()).toMatchInlineSnapshot(`
		{
		  "$typeName": "Ydb.Value",
		  "high128": 0n,
		  "items": [
		    {
		      "$typeName": "Ydb.Value",
		      "high128": 0n,
		      "items": [],
		      "pairs": [],
		      "value": {
		        "case": "int32Value",
		        "value": 1,
		      },
		      "variantIndex": 0,
		    },
		    {
		      "$typeName": "Ydb.Value",
		      "high128": 0n,
		      "items": [],
		      "pairs": [],
		      "value": {
		        "case": "textValue",
		        "value": "a",
		      },
		      "variantIndex": 0,
		    },
		  ],
		  "pairs": [],
		  "value": {
		    "case": undefined,
		  },
		  "variantIndex": 0,
		}
	`)
})
