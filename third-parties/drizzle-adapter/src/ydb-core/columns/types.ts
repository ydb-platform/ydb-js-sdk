import * as Ydb from '@ydbjs/api/value'
import {
	Bool,
	Primitive,
	PrimitiveType,
	Date as YdbDate,
	Datetime as YdbDatetime,
	Double as YdbDouble,
	Float as YdbFloat,
	Int16 as YdbInt16,
	Int64 as YdbInt64,
	Int8 as YdbInt8,
	Interval as YdbInterval,
	Json as YdbJson,
	JsonDocument as YdbJsonDocument,
	Timestamp as YdbTimestamp,
	Uint16 as YdbUint16,
	Uint32 as YdbUint32,
	Uint64 as YdbUint64,
	Uint8 as YdbUint8,
	Uuid as YdbUuid,
	Yson as YdbYson,
} from '@ydbjs/value/primitive'
import { sql as yql } from 'drizzle-orm/sql/sql'
import { customType } from './custom.js'

function escapeYqlString(value: string): string {
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function toUint8Array(value: unknown): Uint8Array {
	if (value instanceof Uint8Array) {
		return value
	}

	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
	}

	if (value instanceof ArrayBuffer) {
		return new Uint8Array(value)
	}

	if (Array.isArray(value)) {
		return Uint8Array.from(value)
	}

	if (typeof value === 'string') {
		return Uint8Array.from(Buffer.from(value, 'latin1'))
	}

	throw new Error(`Cannot decode YDB binary value: ${Object.prototype.toString.call(value)}`)
}

export interface YdbDecimalConfig {
	precision: number
	scale: number
}

const booleanBase = customType<{ data: boolean; driverData: boolean | Bool }>({
	dataType() {
		return 'Bool'
	},
	toDriver(value) {
		return new Bool(value)
	},
})

const int8Base = customType<{ data: number; driverData: YdbInt8 }>({
	dataType() {
		return 'Int8'
	},
	toDriver(value) {
		return new YdbInt8(value)
	},
})

const int16Base = customType<{ data: number; driverData: YdbInt16 }>({
	dataType() {
		return 'Int16'
	},
	toDriver(value) {
		return new YdbInt16(value)
	},
})

const bigintBase = customType<{ data: bigint; driverData: bigint | YdbInt64 }>({
	dataType() {
		return 'Int64'
	},
	toDriver(value) {
		return new YdbInt64(value)
	},
})

const uint8Base = customType<{ data: number; driverData: YdbUint8 }>({
	dataType() {
		return 'Uint8'
	},
	toDriver(value) {
		return new YdbUint8(value)
	},
})

const uint16Base = customType<{ data: number; driverData: YdbUint16 }>({
	dataType() {
		return 'Uint16'
	},
	toDriver(value) {
		return new YdbUint16(value)
	},
})

const uint32Base = customType<{ data: number; driverData: YdbUint32 }>({
	dataType() {
		return 'Uint32'
	},
	toDriver(value) {
		return new YdbUint32(value)
	},
})

const uint64Base = customType<{ data: bigint; driverData: YdbUint64 }>({
	dataType() {
		return 'Uint64'
	},
	toDriver(value) {
		return new YdbUint64(value)
	},
})

const floatBase = customType<{ data: number; driverData: YdbFloat }>({
	dataType() {
		return 'Float'
	},
	toDriver(value) {
		return new YdbFloat(value)
	},
})

const doubleBase = customType<{ data: number; driverData: YdbDouble }>({
	dataType() {
		return 'Double'
	},
	toDriver(value) {
		return new YdbDouble(value)
	},
})

const dyNumberBase = customType<{ data: string; driverData: Primitive }>({
	dataType() {
		return 'DyNumber'
	},
	toDriver(value) {
		return new Primitive(
			{ value: { case: 'textValue', value } },
			new PrimitiveType(Ydb.Type_PrimitiveTypeId.DYNUMBER)
		)
	},
	fromDriver(value) {
		return String(value)
	},
})

const bytesBase = customType<{ data: Uint8Array; driverData: unknown }>({
	dataType() {
		return 'String'
	},
	fromDriver(value) {
		return toUint8Array(value)
	},
})

const dateBase = customType<{ data: Date; driverData: YdbDate }>({
	dataType() {
		return 'Date'
	},
	toDriver(value) {
		return new YdbDate(value)
	},
})

const date32Base = customType<{ data: Date; driverData: Primitive }>({
	dataType() {
		return 'Date32'
	},
	toDriver(value) {
		return new Primitive(
			{ value: { case: 'int32Value', value: Math.floor(value.getTime() / 86400000) } },
			new PrimitiveType(Ydb.Type_PrimitiveTypeId.DATE32)
		)
	},
})

const datetimeBase = customType<{ data: Date; driverData: YdbDatetime }>({
	dataType() {
		return 'Datetime'
	},
	toDriver(value) {
		return new YdbDatetime(value)
	},
})

const datetime64Base = customType<{ data: Date; driverData: Primitive }>({
	dataType() {
		return 'Datetime64'
	},
	toDriver(value) {
		return new Primitive(
			{ value: { case: 'int64Value', value: BigInt(Math.floor(value.getTime() / 1000)) } },
			new PrimitiveType(Ydb.Type_PrimitiveTypeId.DATETIME64)
		)
	},
})

const timestampBase = customType<{ data: Date; driverData: YdbTimestamp }>({
	dataType() {
		return 'Timestamp'
	},
	toDriver(value) {
		return new YdbTimestamp(value)
	},
})

const timestamp64Base = customType<{ data: Date; driverData: Primitive }>({
	dataType() {
		return 'Timestamp64'
	},
	toDriver(value) {
		return new Primitive(
			{ value: { case: 'int64Value', value: BigInt(value.getTime()) * 1000n } },
			new PrimitiveType(Ydb.Type_PrimitiveTypeId.TIMESTAMP64)
		)
	},
})

const intervalBase = customType<{ data: number; driverData: YdbInterval }>({
	dataType() {
		return 'Interval'
	},
	toDriver(value) {
		return new YdbInterval(value)
	},
})

const interval64Base = customType<{ data: bigint | number; driverData: Primitive }>({
	dataType() {
		return 'Interval64'
	},
	toDriver(value) {
		return new Primitive(
			{ value: { case: 'int64Value', value: BigInt(value) } },
			new PrimitiveType(Ydb.Type_PrimitiveTypeId.INTERVAL64)
		)
	},
})

const uuidBase = customType<{ data: string; driverData: YdbUuid }>({
	dataType() {
		return 'Uuid'
	},
	toDriver(value) {
		return new YdbUuid(value)
	},
})

const ysonBase = customType<{ data: Uint8Array; driverData: unknown }>({
	dataType() {
		return 'Yson'
	},
	toDriver(value) {
		return new YdbYson(value instanceof Uint8Array ? value : new Uint8Array(value))
	},
	fromDriver(value) {
		return toUint8Array(value)
	},
})

export function boolean(name?: string) {
	return booleanBase(name as any)
}

export function int8(name?: string) {
	return int8Base(name as any)
}

export function int16(name?: string) {
	return int16Base(name as any)
}

export function bigint(name?: string) {
	return bigintBase(name as any)
}

export function uint8(name?: string) {
	return uint8Base(name as any)
}

export function uint16(name?: string) {
	return uint16Base(name as any)
}

export function uint32(name?: string) {
	return uint32Base(name as any)
}

export function uint64(name?: string) {
	return uint64Base(name as any)
}

export function float(name?: string) {
	return floatBase(name as any)
}

export function double(name?: string) {
	return doubleBase(name as any)
}

export function dyNumber(name?: string) {
	return dyNumberBase(name as any)
}

export function bytes(name?: string) {
	return bytesBase(name as any)
}

export const binary = bytes

export function date(name?: string) {
	return dateBase(name as any)
}

export function date32(name?: string) {
	return date32Base(name as any)
}

export function datetime(name?: string) {
	return datetimeBase(name as any)
}

export function datetime64(name?: string) {
	return datetime64Base(name as any)
}

export function timestamp(name?: string) {
	return timestampBase(name as any)
}

export function timestamp64(name?: string) {
	return timestamp64Base(name as any)
}

export function interval(name?: string) {
	return intervalBase(name as any)
}

export function interval64(name?: string) {
	return interval64Base(name as any)
}

export function json<T = unknown>(name?: string) {
	return customType<{ data: T; driverData: YdbJson }>({
		dataType() {
			return 'Json'
		},
		toDriver(value) {
			return new YdbJson(JSON.stringify(value))
		},
		fromDriver(value) {
			return typeof value === 'string' ? JSON.parse(value) : (value as T)
		},
	})(name as any)
}

export function jsonDocument<T = unknown>(name?: string) {
	return customType<{ data: T; driverData: YdbJsonDocument }>({
		dataType() {
			return 'JsonDocument'
		},
		toDriver(value) {
			return new YdbJsonDocument(JSON.stringify(value))
		},
		fromDriver(value) {
			return typeof value === 'string' ? JSON.parse(value) : (value as T)
		},
	})(name as any)
}

export function uuid(name?: string) {
	return uuidBase(name as any)
}

export function yson(name?: string) {
	return ysonBase(name as any)
}

export function decimal(
	precision: number,
	scale: number
): ReturnType<
	ReturnType<
		typeof customType<{
			data: string
			driverData: string
		}>
	>
>
export function decimal(
	name: string,
	precision: number,
	scale: number
): ReturnType<
	ReturnType<
		typeof customType<{
			data: string
			driverData: string
		}>
	>
>
export function decimal(
	nameOrPrecision: string | number,
	precisionOrScale: number,
	scaleOrUndefined?: number
) {
	const name = typeof nameOrPrecision === 'string' ? nameOrPrecision : ''
	const precision = typeof nameOrPrecision === 'string' ? precisionOrScale : nameOrPrecision
	const scale = typeof nameOrPrecision === 'string' ? scaleOrUndefined : precisionOrScale

	if (scale === undefined) {
		throw new Error('YDB decimal() requires precision and scale')
	}

	return customType<{
		data: string
		driverData: string
	}>({
		dataType() {
			return `Decimal(${precision}, ${scale})`
		},
		toDriver(value) {
			if (!/^-?\d+(?:\.\d+)?$/.test(value)) {
				throw new Error(`Invalid decimal value: ${value}`)
			}

			return yql.raw(`Decimal(${escapeYqlString(value)}, ${precision}, ${scale})`)
		},
		fromDriver(value) {
			return String(value)
		},
	})(name)
}

export { customType }
