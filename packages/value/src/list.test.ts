import { test } from 'vitest'

import { List } from './list.js'
import { Uint32 } from './primitive.js'

test('creates empty list', async (t) => {
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

test('creates list of values', async (t) => {
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
