import { test } from 'vitest'

import { Dict } from './dict.js'
import { Text, Uint32 } from './primitive.js'

test('creates empty dict', async (t) => {
	let dict = new Dict()

	t.expect(dict).toMatchInlineSnapshot(`
		Dict {
		  "pairs": [],
		  "type": DictType {
		    "key": NullType {},
		    "value": NullType {},
		  },
		}
	`)
})

test('creates dict of pairs', async (t) => {
	let dict = new Dict([new Uint32(1), new Text('a')], [new Uint32(2), new Text('b')])

	t.expect(dict).toMatchInlineSnapshot(`
		Dict {
		  "pairs": [
		    [
		      Uint32 {
		        "type": Uint32Type {},
		        "value": 1,
		      },
		      Text {
		        "type": TextType {},
		        "value": "a",
		      },
		    ],
		    [
		      Uint32 {
		        "type": Uint32Type {},
		        "value": 2,
		      },
		      Text {
		        "type": TextType {},
		        "value": "b",
		      },
		    ],
		  ],
		  "type": DictType {
		    "key": Uint32Type {},
		    "value": TextType {},
		  },
		}
	`)
})

test('iterates over pairs in insertion order', async (t) => {
	let dict = new Dict([new Uint32(1), new Text('a')], [new Uint32(2), new Text('b')])

	let collected: [number, string][] = []
	for (let [k, v] of dict) {
		collected.push([(k as Uint32).value, (v as Text).value])
	}

	t.expect(collected).toEqual([
		[1, 'a'],
		[2, 'b'],
	])
})

test('encodes key and value type to protobuf', async (t) => {
	let dict = new Dict([new Uint32(1), new Text('a')])

	t.expect(dict.type.encode()).toMatchInlineSnapshot(`
		{
		  "$typeName": "Ydb.Type",
		  "type": {
		    "case": "dictType",
		    "value": {
		      "$typeName": "Ydb.DictType",
		      "key": {
		        "$typeName": "Ydb.Type",
		        "type": {
		          "case": "typeId",
		          "value": 2,
		        },
		      },
		      "payload": {
		        "$typeName": "Ydb.Type",
		        "type": {
		          "case": "typeId",
		          "value": 4608,
		        },
		      },
		    },
		  },
		}
	`)
})

test('encodes pairs to protobuf value', async (t) => {
	let dict = new Dict([new Uint32(1), new Text('a')])

	t.expect(dict.encode()).toMatchInlineSnapshot(`
		{
		  "$typeName": "Ydb.Value",
		  "high128": 0n,
		  "items": [],
		  "pairs": [
		    {
		      "$typeName": "Ydb.ValuePair",
		      "key": {
		        "$typeName": "Ydb.Value",
		        "high128": 0n,
		        "items": [],
		        "pairs": [],
		        "value": {
		          "case": "uint32Value",
		          "value": 1,
		        },
		        "variantIndex": 0,
		      },
		      "payload": {
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
		    },
		  ],
		  "value": {
		    "case": undefined,
		  },
		  "variantIndex": 0,
		}
	`)
})
