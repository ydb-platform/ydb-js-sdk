import * as assert from "node:assert";
import test from "node:test";

import { create } from "@bufbuild/protobuf";
import { ValueSchema } from "@ydbjs/api/value";

import { List } from "../dist/esm/list.js";
import { Uint32 } from "../dist/esm/primitive.js";

test('List', async (tc) => {
	await tc.test('empty', () => {
		let list = new List()

		assert.deepStrictEqual(list.encode(), create(ValueSchema, {
			items: [],
			pairs: [],
			value: {
				case: undefined
			}
		}))
	})

	await tc.test('value', () => {
		let list = new List(new Uint32(1), new Uint32(2))

		assert.deepStrictEqual(list.encode(), create(ValueSchema, {
			items: [
				{
					value: { case: 'uint32Value', value: 1 },
				},
				{
					value: { case: 'uint32Value', value: 2 },
				}
			],
		}))
	})
})
