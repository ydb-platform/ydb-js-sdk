import { test } from 'vitest'

import { typeToString } from './print.js'
import {
	BoolType,
	BytesType,
	DateType,
	DatetimeType,
	DoubleType,
	FloatType,
	Int16Type,
	Int32Type,
	Int64Type,
	Int8Type,
	IntervalType,
	JsonDocumentType,
	JsonType,
	TextType,
	TimestampType,
	TzDateType,
	TzDatetimeType,
	TzTimestampType,
	Uint16Type,
	Uint32Type,
	Uint64Type,
	Uint8Type,
	UuidType,
	YsonType,
} from './primitive.js'
import { ListType } from './list.js'
import { DictType } from './dict.js'
import { TupleType } from './tuple.js'
import { StructType } from './struct.js'
import { OptionalType } from './optional.js'
import { NullType } from './null.js'

test('prints primitive types', (t) => {
	t.expect(typeToString(new BoolType())).toMatchInlineSnapshot(`"Bool"`)
	t.expect(typeToString(new Int8Type())).toMatchInlineSnapshot(`"Int8"`)
	t.expect(typeToString(new Uint8Type())).toMatchInlineSnapshot(`"Uint8"`)
	t.expect(typeToString(new Int16Type())).toMatchInlineSnapshot(`"Int16"`)
	t.expect(typeToString(new Uint16Type())).toMatchInlineSnapshot(`"Uint16"`)
	t.expect(typeToString(new Int32Type())).toMatchInlineSnapshot(`"Int32"`)
	t.expect(typeToString(new Uint32Type())).toMatchInlineSnapshot(`"Uint32"`)
	t.expect(typeToString(new Int64Type())).toMatchInlineSnapshot(`"Int64"`)
	t.expect(typeToString(new Uint64Type())).toMatchInlineSnapshot(`"Uint64"`)
	t.expect(typeToString(new FloatType())).toMatchInlineSnapshot(`"Float"`)
	t.expect(typeToString(new DoubleType())).toMatchInlineSnapshot(`"Double"`)
	t.expect(typeToString(new TextType())).toMatchInlineSnapshot(`"Utf8"`)
	t.expect(typeToString(new BytesType())).toMatchInlineSnapshot(`"String"`)
	t.expect(typeToString(new YsonType())).toMatchInlineSnapshot(`"Yson"`)
	t.expect(typeToString(new JsonType())).toMatchInlineSnapshot(`"Json"`)
	t.expect(typeToString(new JsonDocumentType())).toMatchInlineSnapshot(
		`"JsonDocument"`
	)
	t.expect(typeToString(new UuidType())).toMatchInlineSnapshot(`"Uuid"`)
	t.expect(typeToString(new DateType())).toMatchInlineSnapshot(`"Date"`)
	t.expect(typeToString(new TzDateType())).toMatchInlineSnapshot(`"TzDate"`)
	t.expect(typeToString(new DatetimeType())).toMatchInlineSnapshot(
		`"Datetime"`
	)
	t.expect(typeToString(new TzDatetimeType())).toMatchInlineSnapshot(
		`"TzDatetime"`
	)
	t.expect(typeToString(new IntervalType())).toMatchInlineSnapshot(
		`"Interval"`
	)
	t.expect(typeToString(new TimestampType())).toMatchInlineSnapshot(
		`"Timestamp"`
	)
	t.expect(typeToString(new TzTimestampType())).toMatchInlineSnapshot(
		`"TzTimestamp"`
	)
})

test('prints List type', (t) => {
	const intList = new ListType(new Int32Type())
	t.expect(typeToString(intList)).toMatchInlineSnapshot(`"List<Int32>"`)

	const nestedList = new ListType(new ListType(new BoolType()))
	t.expect(typeToString(nestedList)).toMatchInlineSnapshot(
		`"List<List<Bool>>"`
	)
})

test('prints Dict type', (t) => {
	const stringToInt = new DictType(new TextType(), new Int32Type())
	t.expect(typeToString(stringToInt)).toMatchInlineSnapshot(
		`"Dict<Utf8,Int32>"`
	)

	const nestedDict = new DictType(
		new BytesType(),
		new ListType(new DoubleType())
	)
	t.expect(typeToString(nestedDict)).toMatchInlineSnapshot(
		`"Dict<String,List<Double>>"`
	)
})

test('prints Tuple type', (t) => {
	const simpleTuple = new TupleType([new BoolType(), new Int32Type()])
	t.expect(typeToString(simpleTuple)).toMatchInlineSnapshot(
		`"Tuple<Bool,Int32>"`
	)

	const complexTuple = new TupleType([
		new BytesType(),
		new ListType(new DoubleType()),
		new DictType(new TextType(), new Int32Type()),
	])
	t.expect(typeToString(complexTuple)).toMatchInlineSnapshot(
		`"Tuple<String,List<Double>,Dict<Utf8,Int32>>"`
	)
})

test('prints Struct type', (t) => {
	const simpleStruct = new StructType(
		['id', 'name'],
		[new Int32Type(), new BytesType()]
	)
	t.expect(typeToString(simpleStruct)).eq('Struct<id:Int32,name:String>')

	const nestedStruct = new StructType(
		['person', 'scores'],
		[
			new StructType(['name', 'age'], [new BytesType(), new Int32Type()]),
			new ListType(new DoubleType()),
		]
	)
	t.expect(typeToString(nestedStruct)).toMatchInlineSnapshot(
		`"Struct<person:Struct<age:Int32,name:String>,scores:List<Double>>"`
	)
})

test('prints Optional type', (t) => {
	const optionalInt = new OptionalType(new Int32Type())
	t.expect(typeToString(optionalInt)).toMatchInlineSnapshot(
		`"Optional<Int32>"`
	)

	const optionalList = new OptionalType(new ListType(new BoolType()))
	t.expect(typeToString(optionalList)).toMatchInlineSnapshot(
		`"Optional<List<Bool>>"`
	)
})

test('prints Null type', (t) => {
	t.expect(typeToString(new NullType())).toMatchInlineSnapshot(`"Null"`)
})
