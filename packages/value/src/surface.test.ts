import { create } from '@bufbuild/protobuf'
import * as Ydb from '@ydbjs/api/value'
import { expect, test } from 'vitest'

import { fromYdb } from './index.js'
import * as P from './primitive.js'
import { Dict } from './dict.js'
import { List } from './list.js'
import { Null } from './null.js'
import { Tuple } from './tuple.js'
import { Struct } from './struct.js'

test('rejects runtime constructor schemas that cannot describe their empty contents', () => {
	expect(() => new List([], new P.Int32Type() as never)).toThrow(/ListType/)
	expect(() => new Dict([], new P.Int32Type() as never)).toThrow(/DictType/)
})

test('rejects malformed wire values instead of discarding incompatible payloads', () => {
	let scalar = new P.Int32(42).encode()
	for (let value of [new List(), new Dict(), new Tuple(), new Struct({}), new Null()]) {
		expect(() => fromYdb(scalar, value.type.encode())).toThrow(/scalar|null|Empty/)
	}
})

test('rejects Variant schemas before decoding root, absent Optional or empty List values', () => {
	let variant = create(Ydb.TypeSchema, {
		type: {
			case: 'variantType',
			value: {
				type: { case: 'tupleItems', value: { elements: [new P.Int32Type().encode()] } },
			},
		},
	})
	let value = create(Ydb.ValueSchema, {
		value: { case: 'nestedValue', value: new P.Int32(42).encode() },
	})
	let absent = create(Ydb.ValueSchema, { value: { case: 'nullFlagValue', value: 0 } })
	let optional = create(Ydb.TypeSchema, {
		type: { case: 'optionalType', value: { item: variant } },
	})
	let list = create(Ydb.TypeSchema, {
		type: { case: 'listType', value: { item: variant } },
	})

	for (let [wire, type] of [
		[value, variant],
		[absent, optional],
		[create(Ydb.ValueSchema), list],
	] as const) {
		expect(() => fromYdb(wire, type)).toThrow(
			'YDB Variant values require raw result mode: use .raw() or { raw: true }.'
		)
	}
})

test('rejects PostgreSQL text, binary and null values without native coercion', () => {
	let type = create(Ydb.TypeSchema, {
		type: { case: 'pgType', value: { typeName: 'pgint4', oid: 23 } },
	})
	let values = [
		create(Ydb.ValueSchema, { value: { case: 'textValue', value: '42' } }),
		create(Ydb.ValueSchema, {
			value: { case: 'bytesValue', value: new Uint8Array([0, 0, 0, 42]) },
		}),
		create(Ydb.ValueSchema, { value: { case: 'nullFlagValue', value: 0 } }),
	]

	for (let value of values) {
		expect(() => {
			return fromYdb(value, type)
		}).toThrow('YDB PostgreSQL values are not supported: use .raw() or { raw: true }.')
	}
})

test('rejects nested PostgreSQL schemas in absent Optionals and empty Lists', () => {
	let pg = create(Ydb.TypeSchema, {
		type: { case: 'pgType', value: { typeName: 'pgint4', oid: 23 } },
	})
	let optional = create(Ydb.TypeSchema, {
		type: {
			case: 'optionalType',
			value: { item: { type: { case: 'listType', value: { item: pg } } } },
		},
	})
	let list = create(Ydb.TypeSchema, {
		type: {
			case: 'listType',
			value: {
				item: {
					type: { case: 'structType', value: { members: [{ name: 'value', type: pg }] } },
				},
			},
		},
	})
	let absent = create(Ydb.ValueSchema, { value: { case: 'nullFlagValue', value: 0 } })
	let empty = create(Ydb.ValueSchema)

	for (let [value, type] of [
		[absent, optional],
		[empty, list],
	] as const) {
		expect(() => {
			return fromYdb(value, type)
		}).toThrow('YDB PostgreSQL values are not supported: use .raw() or { raw: true }.')
	}
})
