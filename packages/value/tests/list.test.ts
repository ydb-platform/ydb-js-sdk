import { test } from 'vitest'

import { List } from '../dist/esm/list.js'
import { Uint32 } from '../dist/esm/primitive.js'

test('empty list', async (tc) => {
	let list = new List()

	tc.expect(list).toMatchInlineSnapshot(`
		List {
		  "items": [],
		  "type": ListType {
		    "item": NullType {},
		  },
		}
	`)
})

test('list of values', async (tc) => {
	let list = new List(new Uint32(1), new Uint32(2))

	tc.expect(list).toMatchInlineSnapshot(`
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
