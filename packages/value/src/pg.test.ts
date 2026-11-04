import { fromBinary, toBinary } from '@bufbuild/protobuf'
import * as Ydb from '@ydbjs/api/value'
import { expect, test } from 'vitest'
import { fromYdb, toJs } from './index.js'
import { Optional } from './optional.js'
import { Pg, PgType } from './pg.js'
import type { Value } from './value.js'

function roundTrip(value: Value): Value {
	let type = fromBinary(Ydb.TypeSchema, toBinary(Ydb.TypeSchema, value.type.encode()))
	let wire = fromBinary(Ydb.ValueSchema, toBinary(Ydb.ValueSchema, value.encode()))
	let decoded = fromYdb(wire, type)
	expect(decoded.type.encode()).toEqual(type)
	expect(decoded.encode()).toEqual(wire)
	return decoded
}

test('Pg type string shorthand produces canonical scalar and array names', () => {
	for (let [input, expected] of [
		['int4', 'pgint4'],
		['PgInt4', 'pgint4'],
		['_int4', '_pgint4'],
		['_PgInt4', '_pgint4'],
	] as const) {
		expect(new PgType(input).typeName).toBe(expected)
	}
	expect(new PgType({ oid: 23 }).encode().type).toMatchObject({
		case: 'pgType',
		value: { oid: 23, typeName: '' },
	})
})

test('Pg preserves descriptor metadata and opaque text, binary and null payloads', () => {
	let descriptor = { typeName: 'pgint4', typeModifier: '', oid: 23, typlen: 4, typmod: -1 }
	let type = new PgType(descriptor)
	let payloads = ['42', new Uint8Array([0, 0, 0, 42]), null]
	for (let payload of payloads) {
		let value = new Pg(payload, type)
		let decoded = roundTrip(value) as Pg
		expect(decoded).toBeInstanceOf(Pg)
		expect(decoded.value).toEqual(payload)
		expect(decoded.type).toMatchObject(descriptor)
		expect(toJs(decoded)).toBe(decoded)
	}
})

test('present optional Pg null remains distinct from an absent optional', () => {
	let type = new PgType({ typeName: 'pgint4', oid: 23, typlen: 4, typmod: -1 })
	let present = roundTrip(new Optional(new Pg(null, type))) as Optional<PgType>
	let absent = roundTrip(new Optional(null, type)) as Optional<PgType>
	expect(present.item).toBeInstanceOf(Pg)
	expect((present.item as Pg).value).toBeNull()
	expect(absent.item).toBeNull()
	expect(present.encode().value.case).toBe('nestedValue')
	expect(absent.encode().value.case).toBe('nullFlagValue')
})

test('Pg rejects invalid descriptors and non-wire payloads', () => {
	for (let descriptor of [
		{},
		{ oid: 0 },
		{ oid: -1 },
		{ oid: 1.5 },
		{ oid: 0x100000000 },
		{ typeName: 'pgint4', typlen: 0x80000000 },
		{ typeName: 'pgint4', typmod: -0x80000001 },
	]) {
		expect(() => new PgType(descriptor)).toThrow(/Pg/)
	}
	expect(() => new PgType('')).toThrow(/name or a nonzero OID/)
	expect(() => new Pg(42 as never, new PgType('int4'))).toThrow(/text, binary bytes, or null/)
})

test('normalizes native PostgreSQL names whose names already start with pg_', () => {
	expect(new PgType('pg_lsn').typeName).toBe('pgpg_lsn')
	expect(new PgType('_pg_lsn').typeName).toBe('_pgpg_lsn')
	expect(new PgType('pgpg_lsn').typeName).toBe('pgpg_lsn')
})
