import * as Ydb from '@ydbjs/api/value'

import { Decimal, DecimalType } from './decimal.js'
import { Dict, DictType } from './dict.js'
import { Empty, EmptyType } from './empty.js'
import { List, ListType } from './list.js'
import { Null, NullType } from './null.js'
import { Optional, OptionalType } from './optional.js'
import { Primitive, PrimitiveType } from './primitive.js'
import { Struct, StructType } from './struct.js'
import { Tuple, TupleType } from './tuple.js'
import { type Type, TypeKind } from './type.js'
import type { Value } from './value.js'

function decodeType(wire: Ydb.Type): Type {
	switch (wire.type.case) {
		case 'typeId':
			return new PrimitiveType(wire.type.value)
		case 'decimalType':
			return new DecimalType(wire.type.value.precision, wire.type.value.scale)
		case 'optionalType':
			return new OptionalType(decodeType(wire.type.value.item!))
		case 'listType':
			return new ListType(decodeType(wire.type.value.item!))
		case 'dictType':
			return new DictType(
				decodeType(wire.type.value.key!),
				decodeType(wire.type.value.payload!)
			)
		case 'tupleType':
			return new TupleType(wire.type.value.elements.map(decodeType))
		case 'structType':
			return new StructType(
				wire.type.value.members.map((member) => member.name),
				wire.type.value.members.map((member) => decodeType(member.type!)),
				true
			)
		case 'nullType':
			return new NullType()
		case 'emptyListType':
			return new EmptyType(TypeKind.EMPTY_LIST)
		case 'emptyDictType':
			return new EmptyType(TypeKind.EMPTY_DICT)
		default:
			throw new TypeError(`Unsupported YDB type: ${wire.type.case}`)
	}
}

function decodeValue(wire: Ydb.Value, type: Type): Value {
	switch (type.kind) {
		case TypeKind.PRIMITIVE:
			return new Primitive(wire, type as PrimitiveType)
		case TypeKind.DECIMAL: {
			if (wire.value.case !== 'low128')
				throw new TypeError('Decimal requires a 128-bit value')
			return new Decimal(
				BigInt.asIntN(128, (wire.high128 << 64n) | wire.value.value),
				type as DecimalType
			)
		}
		case TypeKind.OPTIONAL: {
			let itemType = (type as OptionalType).itemType
			return new Optional(
				wire.value.case === 'nullFlagValue'
					? null
					: decodeValue(
							wire.value.case === 'nestedValue' ? wire.value.value : wire,
							itemType
						),
				itemType
			)
		}
		case TypeKind.LIST:
			return new List(
				wire.items.map((item) => decodeValue(item, (type as ListType).item)),
				type as ListType
			)
		case TypeKind.DICT:
			return new Dict(
				wire.pairs.map((pair): [Value, Value] => [
					decodeValue(pair.key!, (type as DictType).key),
					decodeValue(pair.payload!, (type as DictType).value),
				]),
				type as DictType
			)
		case TypeKind.TUPLE: {
			let elements = (type as TupleType).elements
			if (wire.items.length !== elements.length)
				throw new TypeError('Tuple value does not match its type length')
			return new Tuple(
				...wire.items.map((item, index) => decodeValue(item, elements[index]!))
			)
		}
		case TypeKind.STRUCT: {
			let def = type as StructType
			if (wire.items.length !== def.names.length)
				throw new TypeError('Struct value does not match its type length')
			let fields: Record<string, Value> = Object.create(null)
			for (let [index, name] of def.names.entries())
				fields[name] = decodeValue(wire.items[index]!, def.types[index]!)
			return new Struct(fields, def)
		}
		case TypeKind.NULL:
			return new Null()
		case TypeKind.EMPTY_LIST:
		case TypeKind.EMPTY_DICT:
			if (wire.items.length || wire.pairs.length || wire.value.case !== undefined)
				throw new TypeError('Empty container cannot contain values')
			return new Empty(type as EmptyType)
		default:
			throw new TypeError(`Unsupported YDB value kind: ${type.kind}`)
	}
}

export function fromYdb(value: Ydb.Value, type: Ydb.Type): Value {
	return decodeValue(value, decodeType(type))
}
