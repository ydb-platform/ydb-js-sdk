import { TZDate } from '@date-fns/tz'
import * as Ydb from '@ydbjs/api/value'

import { Dict } from './dict.js'
import { List } from './list.js'
import { Null } from './null.js'
import { Optional } from './optional.js'
import { Bool, Bytes, Datetime, Double, Int32, Int64, Primitive, PrimitiveType, Text, TzDatetime, Uuid } from './primitive.js'
import { Struct, StructType } from './struct.js'
import { Tuple } from './tuple.js'
import { type Type, TypeKind } from './type.js'
import { uuidFromBigInts } from './uuid.js'
import type { Value } from './value.js'

export type JSValue =
	| null
	| boolean
	| number
	| bigint
	| string
	| Date
	| Uint8Array
	| JSValue[]
	| Set<JSValue>
	| Map<JSValue, JSValue>
	| { [key: string]: JSValue }

export function fromYdb(value: Ydb.Value, type: Ydb.Type): Value {
	switch (type.type.case) {
		case 'typeId':
			let pValue = new Primitive({ value: value.value }, new PrimitiveType(type.type.value))
			if (value.high128) {
				//@ts-expect-error
				// Not all primitive types have a high128 property.
				// Do not use this property unless you are sure it exists.
				pValue.high128 = value.high128
			}

			return pValue
		case 'listType':
			return new List(...value.items.map((v) => fromYdb(v, (type.type.value as unknown as Ydb.ListType).item!)))
		case 'tupleType':
			return new Tuple(...value.items.map((v, i) => fromYdb(v, (type.type.value as unknown as Ydb.TupleType).elements[i]!)))
		case 'dictType': {
			let dict: [Value, Value][] = []
			for (let i = 0; i < value.pairs.length; i++) {
				let pair = value.pairs[i]!
				dict.push([fromYdb(pair.key!, type.type.value.key!), fromYdb(pair.payload!, (type.type.value as unknown as Ydb.DictType).payload!)])
			}
			return new Dict(...dict)
		}
		case 'structType': {
			let struct: { [key: string]: Value } = {}
			for (let i = 0; i < value.items.length; i++) {
				let member = (type.type.value as unknown as Ydb.StructType).members[i]!
				struct[member.name] = fromYdb(value.items[i]!, member.type!)
			}

			return new Struct(struct)
		}
		case 'nullType':
			return new Null()
		case 'optionalType':
			if (value.value.case === 'nullFlagValue') {
				return new Null()
			}

			return new Optional(fromYdb(value, type.type.value.item!))
	}

	throw new Error('Unsupported value.')
}

export function fromJs(native: JSValue): Value {
	switch (typeof native) {
		case 'undefined':
			throw new Error('Cannot convert undefined to YDBValue.')
		case 'boolean':
			return new Bool(native)
		case 'number':
			return Number.isInteger(native) ? new Int32(native) : new Double(native)
		case 'bigint':
			return new Int64(native)
		case 'string':
			return new Text(native)
		case 'object': {
			if (native === null) {
				return new Null()
			}

			if (native instanceof Date) {
				return new Datetime(native)
			}

			if (native instanceof TZDate) {
				return new TzDatetime(native)
			}

			if (native instanceof Uint8Array) {
				return new Bytes(native)
			}

			if (native instanceof Set) {
				return new Tuple(...Array.from(native).map(fromJs))
			}

			if (native instanceof Map) {
				let pairs: [Value, Value][] = []

				for (let [key, value] of native.entries()) {
					pairs.push([fromJs(key), fromJs(value)])
				}

				return new Dict(...pairs)
			}

			if (Array.isArray(native)) {
				let values: Value[] = []
				let structs: [string, Value][][] = []

				for (let i = 0; i < native.length; i++) {
					if (typeof native[i] === 'object' && !Array.isArray(native[i]) && native[i] !== null) {
						let element = native[i] as { [key: string]: JSValue }

						let struct: [string, Value][] = []
						for (let key in element) {
							let value = fromJs(element[key]!)
							struct.push([key, value])
						}

						structs.push(struct)
						continue
					}

					values.push(fromJs(native[i]!))
				}

				if (structs.length > 0) {
					let structNames: string[] = []
					let structNamesSet: Set<string> = new Set()
					let structTypes: Type[] = []
					let structValues: { [key: string]: Value }[] = []

					for (let struct of structs) {
						let record: { [key: string]: Value } = {}

						for (let [key, value] of struct) {
							value = new Optional(value)

							if (!structNamesSet.has(key)) {
								structNames.push(key)
								structTypes.push(value.type)

								structNamesSet.add(key)
							}

							record[key] = value
						}

						structValues.push(record)
					}

					let structTypeDef = new StructType(structNames, structTypes)
					for (let struct of structValues) {
						values.push(new Struct(struct, structTypeDef))
					}
				}

				return new List(...values)
			}

			let struct: { [key: string]: Value } = {}
			for (let [k, v] of Object.entries(native)) {
				struct[k] = fromJs(v)
			}

			return new Struct(struct)
		}
	}
}

export function toJs(value: Value): JSValue {
	switch (value.type.kind) {
		case TypeKind.PRIMITIVE:
			switch ((value.type as PrimitiveType).id) {
				case Ydb.Type_PrimitiveTypeId.BOOL:
					return (value as Primitive).value as boolean
				case Ydb.Type_PrimitiveTypeId.INT8:
				case Ydb.Type_PrimitiveTypeId.INT16:
				case Ydb.Type_PrimitiveTypeId.INT32:
				case Ydb.Type_PrimitiveTypeId.UINT8:
				case Ydb.Type_PrimitiveTypeId.UINT16:
				case Ydb.Type_PrimitiveTypeId.UINT32:
				case Ydb.Type_PrimitiveTypeId.FLOAT:
				case Ydb.Type_PrimitiveTypeId.DOUBLE:
					return (value as Primitive).value as number
				case Ydb.Type_PrimitiveTypeId.INT64:
				case Ydb.Type_PrimitiveTypeId.UINT64:
					return (value as Primitive).value as bigint
				case Ydb.Type_PrimitiveTypeId.UTF8:
					return (value as Primitive).value as string
				case Ydb.Type_PrimitiveTypeId.JSON:
				case Ydb.Type_PrimitiveTypeId.JSON_DOCUMENT:
					return JSON.parse((value as Primitive).value as string) as JSValue
				case Ydb.Type_PrimitiveTypeId.STRING:
				case Ydb.Type_PrimitiveTypeId.YSON:
					return (value as Primitive).value as Uint8Array
				case Ydb.Type_PrimitiveTypeId.UUID:
					return uuidFromBigInts((value as Uuid).value as bigint, (value as Uuid).high128)
				case Ydb.Type_PrimitiveTypeId.DATE:
					return new Date(((value as Primitive).value as number) * 24 * 60 * 60 * 1000)
				case Ydb.Type_PrimitiveTypeId.DATETIME:
					return new Date(((value as Primitive).value as number) * 1000)
				case Ydb.Type_PrimitiveTypeId.TIMESTAMP:
					return new Date(Number(((value as Primitive).value as bigint) / 1000n))
				case Ydb.Type_PrimitiveTypeId.TZ_DATE:
				case Ydb.Type_PrimitiveTypeId.TZ_DATETIME:
				case Ydb.Type_PrimitiveTypeId.TZ_TIMESTAMP: {
					let [dateStr, tz] = ((value as Primitive).value as string).split(',')

					return new TZDate(dateStr!, tz!)
				}
			}
			break
		case TypeKind.OPTIONAL: {
			let { item } = value as Optional<Type>
			return item === null ? null : toJs(item)
		}
		case TypeKind.LIST:
		case TypeKind.TUPLE:
			return (value as List).items.map(toJs)
		case TypeKind.DICT: {
			let dict: Map<JSValue, JSValue> = new Map()

			for (let [k, v] of (value as Dict).pairs) {
				dict.set(toJs(k), toJs(v))
			}

			return dict
		}
		case TypeKind.STRUCT: {
			let struct: { [key: string]: JSValue } = {}

			for (let i = 0; i < (value as Struct).type.names.length; i++) {
				struct[(value as Struct).type.names[i]!] = toJs((value as Struct).items[i]!)
			}

			return struct
		}
		case TypeKind.NULL:
			return null
	}

	throw new Error('Unsupported value.')
}
export * from './type.js'
export * from './value.js'
