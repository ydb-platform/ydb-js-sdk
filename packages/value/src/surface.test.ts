import { fromBinary, toBinary } from '@bufbuild/protobuf'
import * as Ydb from '@ydbjs/api/value'
import { expect, test } from 'vitest'

import { fromYdb, toJs } from './index.js'
import * as P from './primitive.js'
import { Decimal, DecimalType } from './decimal.js'
import { Dict } from './dict.js'
import { Empty, EmptyDict, EmptyList } from './empty.js'
import { List } from './list.js'
import { Null } from './null.js'
import { Optional, OptionalType } from './optional.js'
import { Pg, PgType } from './pg.js'
import { Tagged } from './tagged.js'
import { Tuple, TupleType } from './tuple.js'
import { Struct } from './struct.js'
import { Variant, VariantType } from './variant.js'
import { Void } from './void.js'
import type { Type } from './type.js'
import type { Value } from './value.js'

function binary(value: Value): Value {
	let type = fromBinary(Ydb.TypeSchema, toBinary(Ydb.TypeSchema, value.type.encode()))
	let wire = fromBinary(Ydb.ValueSchema, toBinary(Ydb.ValueSchema, value.encode()))
	let decoded = fromYdb(wire, type)
	expect(decoded.type.encode()).toEqual(type)
	expect(decoded.encode()).toEqual(wire)
	return decoded
}

test('covers every exported server primitive ID and every public protocol type kind', () => {
	let primitives = [
		new P.Bool(true),
		new P.Int8(-128),
		new P.Uint8(255),
		new P.Int16(-32768),
		new P.Uint16(65535),
		new P.Int32(-2147483648),
		new P.Uint32(4294967295),
		new P.Int64(-(2n ** 63n)),
		new P.Uint64(2n ** 64n - 1n),
		new P.Float(Infinity),
		new P.Double(NaN),
		new P.Date(0),
		new P.Datetime(1),
		new P.Timestamp(1n),
		new P.Interval(-1),
		new P.TzDate('2025-01-01,UTC'),
		new P.TzDatetime('2025-01-01T00:00:00,UTC'),
		new P.TzTimestamp('2025-01-01T00:00:00.000001,UTC'),
		new P.Date32(-1),
		new P.Datetime64(-1n),
		new P.Timestamp64(-1n),
		new P.Interval64(-1n),
		new P.TzDate32('-1-01-01,UTC'),
		new P.TzDatetime64('-1-01-01T00:00:00,UTC'),
		new P.TzTimestamp64('-1-01-01T00:00:00.000001,UTC'),
		new P.Bytes(Uint8Array.of(0, 255)),
		new P.Text('Привет'),
		new P.Yson(new TextEncoder().encode('{a=1;}')),
		new P.Json('{"x":1}'),
		new P.JsonDocument('{"x":1}'),
		new P.Uuid('00112233-4455-6677-8899-aabbccddeeff'),
		new P.DyNumber('1.23'),
	]
	let ids = [
		...Object.values(Ydb.Type_PrimitiveTypeId),
		...Object.values(P.ExtendedPrimitiveTypeId),
	].filter((id): id is number => typeof id === 'number' && id !== 0)
	expect(primitives.map((value) => value.type.id).sort((a, b) => a - b)).toEqual(
		ids.sort((a, b) => a - b)
	)
	let values: Value[] = [
		...primitives,
		new Decimal('1.23', new DecimalType(22, 9)),
		new Optional(null, new P.Int32Type()),
		new List(new P.Int32(1)),
		new Tuple(new P.Int32(1)),
		new Struct({ x: new P.Int32(1) }),
		new Dict([new P.Text('x'), new P.Int32(1)]),
		new Variant(new P.Int32(1), 0, new VariantType(new TupleType([new P.Int32Type()]))),
		new Tagged(new P.Int32(1), 'id'),
		new Void(),
		new Null(),
		new EmptyList(),
		new EmptyDict(),
		new Pg('42', new PgType('int4')),
	]
	let kinds = new Set(values.map((value) => value.type.encode().type.case))
	expect([...kinds].sort()).toEqual(Ydb.TypeSchema.fields.map((field) => field.localName).sort())
	for (let value of values) expect(() => toJs(binary(value))).not.toThrow()
})

test('keeps the Variant wrapper inside arbitrary present Optional layers', () => {
	let variant = new Variant(
		new P.Int32(42),
		0,
		new VariantType(new TupleType([new P.Int32Type()]))
	)
	let value: Value = variant
	for (let depth = 0; depth < 40; depth++) value = new Optional(value)
	let decoded = binary(value)
	expect(toJs(decoded)).toBeInstanceOf(Variant)
	expect(toJs((toJs(decoded) as Variant).item)).toBe(42)
	expect(decoded.encode()).toEqual(variant.encode())
})

test('rejects a server representation with two possible Optional Variant branches', () => {
	let scalar = new OptionalType(new P.Int32Type())
	let inner = new VariantType(new TupleType([scalar, scalar]))
	let outer = new VariantType(new TupleType([inner, scalar]))
	let value = new Optional(new Variant(new Optional(null, new P.Int32Type()), 1, outer))
	expect(() => fromYdb(value.encode(), value.type.encode())).toThrow(/ambiguous.*raw/i)
	let container = new List(value)
	expect(() => fromYdb(container.encode(), container.type.encode())).toThrow(/ambiguous.*raw/i)
})

test('does not mistake a nested non-null Variant for an Optional wrapper', () => {
	let inner = new VariantType(new TupleType([new P.Int32Type(), new P.Int32Type()]))
	let outer = new VariantType(new TupleType([inner, new P.Int32Type()]))
	let value = new Optional(new Variant(new Variant(new P.Int32(42), 1, inner), 0, outer))
	let decoded = binary(value) as Optional<Type>
	expect((decoded.item as Variant).index).toBe(0)
	expect(((decoded.item as Variant).item as Variant).index).toBe(1)
})

test('rejects runtime constructor schemas that cannot describe their empty contents', () => {
	expect(() => new List([], new P.Int32Type() as never)).toThrow(/ListType/)
	expect(() => new Dict([], new P.Int32Type() as never)).toThrow(/DictType/)
	expect(() => new Empty(new P.Int32Type() as never)).toThrow(/EmptyType/)
})

test('normalizes native PostgreSQL names whose names already start with pg_', () => {
	expect(new PgType('pg_lsn').typeName).toBe('pgpg_lsn')
	expect(new PgType('_pg_lsn').typeName).toBe('_pgpg_lsn')
	expect(new PgType('pgpg_lsn').typeName).toBe('pgpg_lsn')
})
