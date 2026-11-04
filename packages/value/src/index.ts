/// <reference lib="esnext.temporal" preserve="true" />

import {
	isBigInt64Array,
	isBigUint64Array,
	isDate,
	isFloat32Array,
	isFloat64Array,
	isMap,
	isSet,
	isUint8Array,
} from 'node:util/types'

import * as Ydb from '@ydbjs/api/value'

import { Decimal } from './decimal.js'
import { Dict } from './dict.js'
import { List, ListType } from './list.js'
import { Null, NullType } from './null.js'
import { Optional } from './optional.js'
import {
	Bool,
	Bytes,
	Date as DateValue,
	Datetime,
	Double,
	DoubleType,
	ExtendedPrimitiveTypeId,
	Float,
	FloatType,
	Int32,
	Int64,
	Int64Type,
	Interval,
	Primitive,
	PrimitiveType,
	Text,
	Timestamp,
	TzTimestamp,
	Uint64,
	Uint64Type,
	Uuid,
} from './primitive.js'
import { Struct, StructType } from './struct.js'
import { getTemporal, parseTimezoneDate } from './temporal.js'
import { Tuple } from './tuple.js'
import { type Type, TypeKind } from './type.js'
import { uuidFromBigInts } from './uuid.js'
import type { Value } from './value.js'

export type JSValue =
	| Value
	| null
	| boolean
	| number
	| bigint
	| string
	| Date
	| Temporal.PlainDate
	| Temporal.Instant
	| Temporal.ZonedDateTime
	| Temporal.Duration
	| Uint8Array
	| Float32Array
	| Float64Array
	| BigInt64Array
	| BigUint64Array
	| JSValue[]
	| Set<JSValue>
	| Map<JSValue, JSValue>
	| { [key: string]: JSValue }

export { fromYdb } from './decode.js'

function isValue(value: unknown): value is Value {
	return (
		typeof value === 'object' &&
		value !== null &&
		'type' in value &&
		'encode' in value &&
		typeof value.encode === 'function'
	)
}

/**
 * Convert a native JavaScript value into a YDB `Value`. Types are inferred from
 * the input structure.
 *
 * Note: when converting an array of plain objects (`[{}, ...]`), every struct
 * field is wrapped in `Optional`. This lets heterogeneous arrays (objects with different key sets) produce a single
 * unified struct type. As a consequence, the resulting type never matches
 * `NOT NULL` columns on the YDB side.
 *
 * If you target a schema with `NOT NULL` columns, construct values explicitly:
 *
 * ```ts
 * new List(
 *   new Struct({ key: new Text('a'), n: new Uint8(1) })
 * )
 * ```
 *
 * or build a `StructType` and pass it to `new Struct(obj, type)` to pin the
 * field types.
 */

export function fromJs(native: JSValue | Value): Value {
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

			if (isValue(native)) return native

			if (isDate(native)) {
				if ('timeZone' in native)
					throw new TypeError(
						'Use Temporal.ZonedDateTime or an explicit YDB timezone value instead of TZDate'
					)
				return new Datetime(native)
			}
			let temporalKind = Object.prototype.toString.call(native)
			switch (temporalKind) {
				case '[object Temporal.PlainDate]':
					return new DateValue(native as Temporal.PlainDate)
				case '[object Temporal.Instant]':
					return new Timestamp(native as Temporal.Instant)
				case '[object Temporal.ZonedDateTime]':
					return new TzTimestamp(native as Temporal.ZonedDateTime)
				case '[object Temporal.Duration]':
					return new Interval(native as Temporal.Duration)
			}
			if (temporalKind.startsWith('[object Temporal.'))
				throw new TypeError(
					'This Temporal type has no inferred YDB type; use an explicit typed value'
				)

			if (isUint8Array(native)) {
				return new Bytes(native)
			}

			if (isFloat32Array(native)) {
				return new List(
					Array.from(native, (v) => new Float(v)),
					new ListType(new FloatType())
				)
			}

			if (isFloat64Array(native)) {
				return new List(
					Array.from(native, (v) => new Double(v)),
					new ListType(new DoubleType())
				)
			}

			if (isBigInt64Array(native)) {
				return new List(
					Array.from(native, (v) => new Int64(v)),
					new ListType(new Int64Type())
				)
			}

			if (isBigUint64Array(native)) {
				return new List(
					Array.from(native, (v) => new Uint64(v)),
					new ListType(new Uint64Type())
				)
			}

			if (isSet(native)) {
				return new Tuple(...Array.from(native, fromJs))
			}

			if (isMap(native)) {
				let pairs: [Value, Value][] = []

				for (let [key, value] of native.entries()) {
					pairs.push([fromJs(key as JSValue), fromJs(value as JSValue)])
				}

				return new Dict(...pairs)
			}

			if (Array.isArray(native)) {
				let values = native.map(fromJs)
				// Only inferred records participate in the optional-field union.
				if (
					values.length &&
					values.every(
						(value, index) => value instanceof Struct && !isValue(native[index])
					)
				) {
					let names: string[] = []
					let types: Type[] = []
					let seen = new Set<string>()
					let records: Record<string, Value>[] = []
					for (let value of values as Struct[]) {
						let record: Record<string, Value> = Object.create(null)
						for (let [index, name] of value.type.names.entries()) {
							let item = new Optional(value.items[index]!)
							if (!seen.has(name)) {
								seen.add(name)
								names.push(name)
								types.push(item.type)
							}
							record[name] = item
						}
						records.push(record)
					}
					let type = new StructType(names, types)
					values = records.map((record) => new Struct(record, type))
				}
				return new List(values, new ListType(values[0]?.type ?? new NullType()))
			}

			let struct: { [key: string]: Value } = Object.create(null)
			for (let [k, v] of Object.entries(native)) {
				struct[k] = fromJs(v)
			}

			return new Struct(struct)
		}
	}
}

export interface ToJsOptions {
	temporal?: boolean | undefined
}

export function toJs(value: Value, options?: ToJsOptions): JSValue
export function toJs(value: Value, index: number, array: readonly Value[]): JSValue
export function toJs(
	value: Value,
	options?: ToJsOptions | number,
	array?: readonly Value[]
): JSValue {
	// Array.map supplies an index and source array after the value.
	if (typeof options === 'number') {
		if (!Array.isArray(array)) throw new TypeError('toJs options must be an object')
		options = undefined
	}
	if (
		options !== undefined &&
		(options === null || typeof options !== 'object' || Array.isArray(options))
	)
		throw new TypeError('toJs options must be an object')
	let temporal = options?.temporal
	if (temporal !== undefined && typeof temporal !== 'boolean')
		throw new TypeError('temporal must be a boolean')
	return convert(value, temporal ? getTemporal() : undefined)
}

function convert(value: Value, temporal?: typeof Temporal): JSValue {
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
				case Ydb.Type_PrimitiveTypeId.DYNUMBER:
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
				case Ydb.Type_PrimitiveTypeId.DATE32: {
					let days = (value as Primitive).value as number
					if (temporal) {
						// The full YDB Date32 range fits Date; whole UTC days remain exact.
						let date = new Date(days * 86_400_000)
						return new temporal.PlainDate(
							date.getUTCFullYear(),
							date.getUTCMonth() + 1,
							date.getUTCDate()
						)
					}
					return (value.type as PrimitiveType).id === Ydb.Type_PrimitiveTypeId.DATE
						? new Date(days * 86_400_000)
						: value
				}
				case Ydb.Type_PrimitiveTypeId.DATETIME:
				case Ydb.Type_PrimitiveTypeId.DATETIME64: {
					let seconds = (value as Primitive).value as number | bigint
					if (temporal)
						return temporal.Instant.fromEpochNanoseconds(
							BigInt(seconds) * 1_000_000_000n
						)
					return (value.type as PrimitiveType).id === Ydb.Type_PrimitiveTypeId.DATETIME
						? new Date(Number(seconds) * 1000)
						: value
				}
				case Ydb.Type_PrimitiveTypeId.TIMESTAMP:
				case Ydb.Type_PrimitiveTypeId.TIMESTAMP64: {
					let microseconds = (value as Primitive).value as bigint
					if (temporal) return temporal.Instant.fromEpochNanoseconds(microseconds * 1000n)
					return (value.type as PrimitiveType).id === Ydb.Type_PrimitiveTypeId.TIMESTAMP
						? new Date(Number(microseconds / 1000n))
						: value
				}
				case Ydb.Type_PrimitiveTypeId.INTERVAL:
				case Ydb.Type_PrimitiveTypeId.INTERVAL64: {
					if (temporal) {
						let microseconds = BigInt((value as Primitive).value as number | bigint)
						// Each Number component stays exact across the complete Interval64 range.
						return temporal.Duration.from({
							seconds: Number(microseconds / 1_000_000n),
							microseconds: Number(microseconds % 1_000_000n),
						})
					}

					return (value.type as PrimitiveType).id === Ydb.Type_PrimitiveTypeId.INTERVAL
						? Number((value as Primitive).value)
						: value
				}
				case Ydb.Type_PrimitiveTypeId.TZ_DATETIME:
				case Ydb.Type_PrimitiveTypeId.TZ_TIMESTAMP:
				case ExtendedPrimitiveTypeId.TZ_DATETIME64:
				case ExtendedPrimitiveTypeId.TZ_TIMESTAMP64:
					return temporal
						? parseTimezoneDate((value as Primitive).value as string, temporal)
						: value
				case Ydb.Type_PrimitiveTypeId.TZ_DATE:
				case ExtendedPrimitiveTypeId.TZ_DATE32:
					return value
			}
			break
		case TypeKind.OPTIONAL: {
			let { item } = value as Optional<Type>
			return item === null ? null : convert(item, temporal)
		}
		case TypeKind.LIST:
		case TypeKind.TUPLE:
			return (value as List).items.map((item) => convert(item, temporal))
		case TypeKind.DICT: {
			let dict: Map<JSValue, JSValue> = new Map()

			for (let [k, v] of (value as Dict).pairs) {
				dict.set(convert(k, temporal), convert(v, temporal))
			}

			return dict
		}
		case TypeKind.STRUCT: {
			let struct: { [key: string]: JSValue } = Object.create(null)

			for (let i = 0; i < (value as Struct).type.names.length; i++) {
				struct[(value as Struct).type.names[i]!] = convert(
					(value as Struct).items[i]!,
					temporal
				)
			}

			return struct
		}
		case TypeKind.DECIMAL:
			return (value as Decimal).toString()
		case TypeKind.EMPTY_LIST:
			return []
		case TypeKind.EMPTY_DICT:
			return new Map()
		case TypeKind.NULL:
			return null
	}

	return value
}
export * from './type.js'
export * from './value.js'
