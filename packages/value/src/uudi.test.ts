import { expect, test } from "vitest";

import { bigIntsFromUuid, uuidFromBigInts } from "./uuid.js";
import { Uuid } from "./primitive.js";

test('creates UUID', () => {
	let uuid = '123e4567-e89b-12d3-a456-426614174000';
	let { low128, high128 } = bigIntsFromUuid(uuid);

	expect(uuid).toEqual(uuidFromBigInts(low128, high128));
})

test('creates YDB Uuid Type', () => {
	let uuid = new Uuid('123e4567-e89b-12d3-a456-426614174000');
	expect(uuid.toString()).toEqual('123e4567-e89b-12d3-a456-426614174000');
})
