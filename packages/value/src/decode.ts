import { equals } from '@bufbuild/protobuf'
import * as Ydb from '@ydbjs/api/value'

import { Decimal, DecimalType } from './decimal.js'
import { Dict, DictType } from './dict.js'
import { Empty, EmptyType } from './empty.js'
import { List, ListType } from './list.js'
import { Null, NullType } from './null.js'
import { Optional, OptionalType } from './optional.js'
import { Pg, PgType } from './pg.js'
import { Tagged, TaggedType } from './tagged.js'
import { Variant, VariantType } from './variant.js'
import { Void, VoidType } from './void.js'
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
		case 'variantType': {
			let items = wire.type.value.type
			if (items.case === 'tupleItems')
				return new VariantType(new TupleType(items.value.elements.map(decodeType)))
			if (items.case === 'structItems')
				return new VariantType(
					new StructType(
						items.value.members.map((member) => member.name),
						items.value.members.map((member) => decodeType(member.type!)),
						true
					)
				)
			throw new TypeError('Variant requires tuple or struct alternatives')
		}
		case 'taggedType':
			return new TaggedType(wire.type.value.tag, decodeType(wire.type.value.type!))
		case 'pgType':
			return new PgType(wire.type.value)
		case 'voidType':
			return new VoidType()
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

class AmbiguousValueError extends TypeError {
	constructor() {
		super('Ambiguous YDB Optional<Variant> value; read the result with .raw() or { raw: true }')
	}
}

type DecodeCache = WeakMap<Ydb.Value, Map<Type, Value | Error>>

function variantPayload(type: Type): boolean {
	while (type.kind === TypeKind.OPTIONAL || type.kind === TypeKind.TAGGED) {
		type =
			type.kind === TypeKind.OPTIONAL
				? (type as OptionalType).itemType
				: (type as TaggedType).itemType
	}
	return type.kind === TypeKind.VARIANT
}

// Optional and Variant share nested_value; nullable variants can admit two distinct interpretations.
function decodeOptionalVariant(wire: Ydb.Value, type: OptionalType, cache: DecodeCache): Value {
	let values = cache.get(wire)
	if (!values) cache.set(wire, (values = new Map()))
	let cached = values.get(type)
	if (cached instanceof Error) throw cached
	if (cached) return cached
	let terminal = wire
	while (terminal.value.case === 'nestedValue') terminal = terminal.value.value
	let nullable = terminal.value.case === 'nullFlagValue' || terminal.value.case === undefined
	let candidates: Value[] = []
	let error: unknown
	for (let input of wire.value.case === 'nestedValue' && wire.variantIndex === 0 && nullable
		? [wire, wire.value.value]
		: [wire]) {
		try {
			candidates.push(new Optional(decodeValue(input, type.itemType, cache), type.itemType))
		} catch (cause) {
			if (cause instanceof AmbiguousValueError) {
				values.set(type, cause)
				throw cause
			}
			error = cause
		}
	}
	if (!candidates.length) {
		let cause = error instanceof Error ? error : new TypeError('Invalid optional variant value')
		values.set(type, cause)
		throw cause
	}
	if (
		candidates.length > 1 &&
		!equals(Ydb.ValueSchema, candidates[0]!.encode(), candidates[1]!.encode())
	) {
		let cause = new AmbiguousValueError()
		values.set(type, cause)
		throw cause
	}
	let result = candidates[0]!
	values.set(type, result)
	return result
}

function decodeValue(wire: Ydb.Value, type: Type, cache?: DecodeCache): Value {
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
			if (wire.value.case === 'nullFlagValue') return new Optional(null, itemType)
			if (variantPayload(itemType))
				return decodeOptionalVariant(wire, type as OptionalType, cache ?? new WeakMap())
			return new Optional(
				decodeValue(
					wire.value.case === 'nestedValue' ? wire.value.value : wire,
					itemType,
					cache
				),
				itemType
			)
		}
		case TypeKind.VARIANT: {
			if (wire.value.case !== 'nestedValue')
				throw new TypeError('Variant requires a nested value')
			let variant = type as VariantType
			let tag =
				variant.items instanceof TupleType
					? wire.variantIndex
					: variant.items.names[wire.variantIndex]
			let itemType =
				variant.items instanceof TupleType
					? variant.items.elements[wire.variantIndex]
					: variant.items.types[wire.variantIndex]
			if (tag === undefined || !itemType) throw new TypeError('Variant index is out of range')
			return new Variant(decodeValue(wire.value.value, itemType, cache), tag, variant)
		}
		case TypeKind.TAGGED:
			return new Tagged(
				decodeValue(wire, (type as TaggedType).itemType, cache),
				type as TaggedType
			)
		case TypeKind.PG_TYPE:
			if (wire.value.case === 'nullFlagValue') return new Pg(null, type as PgType)
			if (wire.value.case === 'textValue' || wire.value.case === 'bytesValue')
				return new Pg(wire.value.value, type as PgType)
			throw new TypeError('Pg value requires text, bytes or null')

		case TypeKind.LIST:
			if (wire.value.case !== undefined)
				throw new TypeError('List cannot contain a scalar value')
			return new List(
				wire.items.map((item) => decodeValue(item, (type as ListType).item, cache)),
				type as ListType
			)
		case TypeKind.DICT:
			if (wire.value.case !== undefined)
				throw new TypeError('Dict cannot contain a scalar value')
			return new Dict(
				wire.pairs.map((pair): [Value, Value] => [
					decodeValue(pair.key!, (type as DictType).key, cache),
					decodeValue(pair.payload!, (type as DictType).value, cache),
				]),
				type as DictType
			)
		case TypeKind.TUPLE: {
			if (wire.value.case !== undefined)
				throw new TypeError('Tuple cannot contain a scalar value')
			let elements = (type as TupleType).elements
			if (wire.items.length !== elements.length)
				throw new TypeError('Tuple value does not match its type length')
			return new Tuple(
				...wire.items.map((item, index) => decodeValue(item, elements[index]!, cache))
			)
		}
		case TypeKind.STRUCT: {
			if (wire.value.case !== undefined)
				throw new TypeError('Struct cannot contain a scalar value')
			let def = type as StructType
			if (wire.items.length !== def.names.length)
				throw new TypeError('Struct value does not match its type length')
			let fields: Record<string, Value> = Object.create(null)
			for (let [index, name] of def.names.entries())
				fields[name] = decodeValue(wire.items[index]!, def.types[index]!, cache)
			return new Struct(fields, def)
		}
		case TypeKind.NULL:
			if (wire.value.case !== 'nullFlagValue')
				throw new TypeError('Null requires a null flag')
			return new Null()
		case TypeKind.VOID:
		case TypeKind.EMPTY_LIST:
		case TypeKind.EMPTY_DICT:
			if (wire.items.length || wire.pairs.length || wire.value.case !== undefined)
				throw new TypeError('Empty container cannot contain values')
			return type.kind === TypeKind.VOID ? new Void() : new Empty(type as EmptyType)
		default:
			throw new TypeError(`Unsupported YDB value kind: ${type.kind}`)
	}
}

export function fromYdb(value: Ydb.Value, type: Ydb.Type): Value {
	return decodeValue(value, decodeType(type))
}
