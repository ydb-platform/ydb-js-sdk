import { test } from 'vitest'

import { List } from '../dist/esm/list.js'
import { Uint32 } from '../dist/esm/primitive.js'

test('empty list', async (t) => {
	let list = new List()

	t.expect(list).toMatchInlineSnapshot(`
		List {
		  "items": [],
		  "type": ListType {
		    "item": NullType {},
		  },
		}
	`)
})

test('list of values', async (t) => {
	let list = new List(new Uint32(1), new Uint32(2))

	t.expect(list).toMatchInlineSnapshot(`
		List {
		  "items": [
		    Uint32 {
		      "type": Uint32Type {},
		      "value": 1,
		    },
		    Uint32 {
		      "type": Uint32Type {},
		      "value": 2,
		    },
		  ],
		  "type": ListType {
		    "item": Uint32Type {},
		  },
		}
	`)
})
