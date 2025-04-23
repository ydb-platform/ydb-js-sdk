import { expect, test } from 'vitest'

import { typeToString } from '../dist/esm/print.js'
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
} from '../dist/esm/primitive.js'
import { ListType } from '../dist/esm/list.js'
import { DictType } from '../dist/esm/dict.js'
import { TupleType } from '../dist/esm/tuple.js'
import { StructType } from '../dist/esm/struct.js'
import { OptionalType } from '../dist/esm/optional.js'
import { NullType } from '../dist/esm/null.js'

test('primitive types', () => {
	expect(typeToString(new BoolType())).toBe('Bool')
	expect(typeToString(new Int8Type())).toBe('Int8')
	expect(typeToString(new Uint8Type())).toBe('Uint8')
	expect(typeToString(new Int16Type())).toBe('Int16')
	expect(typeToString(new Uint16Type())).toBe('Uint16')
	expect(typeToString(new Int32Type())).toBe('Int32')
	expect(typeToString(new Uint32Type())).toBe('Uint32')
	expect(typeToString(new Int64Type())).toBe('Int64')
	expect(typeToString(new Uint64Type())).toBe('Uint64')
	expect(typeToString(new FloatType())).toBe('Float')
	expect(typeToString(new DoubleType())).toBe('Double')
	expect(typeToString(new TextType())).toBe('Utf8')
	expect(typeToString(new BytesType())).toBe('String')
	expect(typeToString(new YsonType())).toBe('Yson')
	expect(typeToString(new JsonType())).toBe('Json')
	expect(typeToString(new JsonDocumentType())).toBe('JsonDocument')
	expect(typeToString(new UuidType())).toBe('Uuid')
	expect(typeToString(new DateType())).toBe('Date')
	expect(typeToString(new TzDateType())).toBe('TzDate')
	expect(typeToString(new DatetimeType())).toBe('Datetime')
	expect(typeToString(new TzDatetimeType())).toBe('TzDatetime')
	expect(typeToString(new IntervalType())).toBe('Interval')
	expect(typeToString(new TimestampType())).toBe('Timestamp')
	expect(typeToString(new TzTimestampType())).toBe('TzTimestamp')
})

test('List type', () => {
	const intList = new ListType(new Int32Type())
	expect(typeToString(intList)).toBe('List<Int32>')

	const nestedList = new ListType(new ListType(new BoolType()))
	expect(typeToString(nestedList)).toBe('List<List<Bool>>')
})

test('Dict type', () => {
	const stringToInt = new DictType(new TextType(), new Int32Type())
	expect(typeToString(stringToInt)).toBe('Dict<Utf8,Int32>')

	const nestedDict = new DictType(new BytesType(), new ListType(new DoubleType()))
	expect(typeToString(nestedDict)).toBe('Dict<String,List<Double>>')
})

test('Tuple type', () => {
	const simpleTuple = new TupleType([new BoolType(), new Int32Type()])
	expect(typeToString(simpleTuple)).toBe('Tuple<Bool,Int32>')

	const complexTuple = new TupleType([new BytesType(), new ListType(new DoubleType()), new DictType(new TextType(), new Int32Type())])
	expect(typeToString(complexTuple)).toBe('Tuple<String,List<Double>,Dict<Utf8,Int32>>')
})

test('Struct type', () => {
	const simpleStruct = new StructType(['id', 'name'], [new Int32Type(), new BytesType()])
	expect(typeToString(simpleStruct)).toBe('Struct<id:Int32,name:String>')

	const nestedStruct = new StructType(
		['person', 'scores'],
		[new StructType(['name', 'age'], [new BytesType(), new Int32Type()]), new ListType(new DoubleType())]
	)
	expect(typeToString(nestedStruct)).toBe('Struct<person:Struct<age:Int32,name:String>,scores:List<Double>>')
})

test('Optional type', () => {
	const optionalInt = new OptionalType(new Int32Type())
	expect(typeToString(optionalInt)).toBe('Optional<Int32>')

	const optionalList = new OptionalType(new ListType(new BoolType()))
	expect(typeToString(optionalList)).toBe('Optional<List<Bool>>')
})

test('Null type', () => {
	expect(typeToString(new NullType())).toBe('Null')
})
