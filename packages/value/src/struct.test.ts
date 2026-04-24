import { test } from 'vitest'

import { Optional, OptionalType } from './optional.js'
import { Int32, Int32Type, Text, TextType } from './primitive.js'
import { Struct, StructType } from './struct.js'

test('throws when non-optional field is missing', async (t) => {
	let def = new StructType(['id', 'name'], [new Int32Type(), new TextType()])

	t.expect(() => new Struct({ id: new Int32(1) }, def)).toThrowErrorMatchingInlineSnapshot(
		`[Error: Field name is declared as Utf8 but no value provided.]`
	)
})

test('fills missing optional fields with Optional(null)', async (t) => {
	let def = new StructType(
		['age', 'name'],
		[new OptionalType(new Int32Type()), new OptionalType(new TextType())]
	)

	let s = new Struct({ name: new Optional(new Text('Alice')) }, def)

	t.expect(s).toMatchInlineSnapshot(`
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
		        "value": "Alice",
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
		}
	`)
})
