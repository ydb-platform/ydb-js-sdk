import { type MessageInitShape, create } from '@bufbuild/protobuf'
import type { GenMessage } from '@bufbuild/protobuf/codegenv1'
import type { TZDate } from '@date-fns/tz'
import * as Ydb from '@ydbjs/api/value'
import type { GenericDateConstructor } from 'date-fns'

import { timezoneText } from './temporal.js'
import { type Type, TypeKind } from './type.js'
import { bigIntsFromUuid, uuidFromBigInts } from './uuid.js'
import { type Value } from './value.js'

// ydbd exports these IDs even though the public protobuf enum does not name them.
export enum ExtendedPrimitiveTypeId {
	TZ_DATE32 = 68,
	TZ_DATETIME64 = 69,
	TZ_TIMESTAMP64 = 70,
}

export type PrimitiveTypeId = Ydb.Type_PrimitiveTypeId | ExtendedPrimitiveTypeId

export class PrimitiveType implements Type {
	declare id: PrimitiveTypeId

	#type: MessageInitShape<GenMessage<Ydb.Type>>
	#typeInstance?: Ydb.Type

	constructor(typeId: PrimitiveTypeId) {
		this.#type = { type: { case: 'typeId', value: typeId as Ydb.Type_PrimitiveTypeId } }

		Object.defineProperty(this, 'id', {
			value: typeId,
			writable: false,
			enumerable: false,
			configurable: false,
		})
	}

	get kind(): TypeKind.PRIMITIVE {
		return TypeKind.PRIMITIVE
	}

	encode(): Ydb.Type {
		if (!this.#typeInstance) {
			this.#typeInstance = create(Ydb.TypeSchema, this.#type)
		}

		return this.#typeInstance
	}
}

let primitiveFields: Partial<Record<PrimitiveTypeId, Ydb.Value['value']['case']>> = {
	[Ydb.Type_PrimitiveTypeId.BOOL]: 'boolValue',
	[Ydb.Type_PrimitiveTypeId.INT8]: 'int32Value',
	[Ydb.Type_PrimitiveTypeId.INT16]: 'int32Value',
	[Ydb.Type_PrimitiveTypeId.INT32]: 'int32Value',
	[Ydb.Type_PrimitiveTypeId.UINT8]: 'uint32Value',
	[Ydb.Type_PrimitiveTypeId.UINT16]: 'uint32Value',
	[Ydb.Type_PrimitiveTypeId.UINT32]: 'uint32Value',
	[Ydb.Type_PrimitiveTypeId.INT64]: 'int64Value',
	[Ydb.Type_PrimitiveTypeId.UINT64]: 'uint64Value',
	[Ydb.Type_PrimitiveTypeId.FLOAT]: 'floatValue',
	[Ydb.Type_PrimitiveTypeId.DOUBLE]: 'doubleValue',
	[Ydb.Type_PrimitiveTypeId.DATE]: 'uint32Value',
	[Ydb.Type_PrimitiveTypeId.DATETIME]: 'uint32Value',
	[Ydb.Type_PrimitiveTypeId.TIMESTAMP]: 'uint64Value',
	[Ydb.Type_PrimitiveTypeId.INTERVAL]: 'int64Value',
	[Ydb.Type_PrimitiveTypeId.TZ_DATE]: 'textValue',
	[Ydb.Type_PrimitiveTypeId.TZ_DATETIME]: 'textValue',
	[Ydb.Type_PrimitiveTypeId.TZ_TIMESTAMP]: 'textValue',
	[Ydb.Type_PrimitiveTypeId.DATE32]: 'int32Value',
	[Ydb.Type_PrimitiveTypeId.DATETIME64]: 'int64Value',
	[Ydb.Type_PrimitiveTypeId.TIMESTAMP64]: 'int64Value',
	[Ydb.Type_PrimitiveTypeId.INTERVAL64]: 'int64Value',
	[Ydb.Type_PrimitiveTypeId.STRING]: 'bytesValue',
	[Ydb.Type_PrimitiveTypeId.UTF8]: 'textValue',
	[Ydb.Type_PrimitiveTypeId.YSON]: 'bytesValue',
	[Ydb.Type_PrimitiveTypeId.JSON]: 'textValue',
	[Ydb.Type_PrimitiveTypeId.UUID]: 'low128',
	[Ydb.Type_PrimitiveTypeId.JSON_DOCUMENT]: 'textValue',
	[Ydb.Type_PrimitiveTypeId.DYNUMBER]: 'textValue',
	[ExtendedPrimitiveTypeId.TZ_DATE32]: 'textValue',
	[ExtendedPrimitiveTypeId.TZ_DATETIME64]: 'textValue',
	[ExtendedPrimitiveTypeId.TZ_TIMESTAMP64]: 'textValue',
}

let integerRanges: Partial<Record<PrimitiveTypeId, [number, number] | [bigint, bigint]>> = {
	[Ydb.Type_PrimitiveTypeId.INT8]: [-128, 127],
	[Ydb.Type_PrimitiveTypeId.UINT8]: [0, 255],
	[Ydb.Type_PrimitiveTypeId.INT16]: [-32768, 32767],
	[Ydb.Type_PrimitiveTypeId.UINT16]: [0, 65535],
	[Ydb.Type_PrimitiveTypeId.INT32]: [-2147483648, 2147483647],
	[Ydb.Type_PrimitiveTypeId.UINT32]: [0, 4294967295],
	[Ydb.Type_PrimitiveTypeId.INT64]: [-(2n ** 63n), 2n ** 63n - 1n],
	[Ydb.Type_PrimitiveTypeId.UINT64]: [0n, 2n ** 64n - 1n],
	[Ydb.Type_PrimitiveTypeId.DATE]: [0, 49672],
	[Ydb.Type_PrimitiveTypeId.DATETIME]: [0, 4_291_747_199],
	[Ydb.Type_PrimitiveTypeId.TIMESTAMP]: [0n, 4_291_747_199_999_999n],
	[Ydb.Type_PrimitiveTypeId.INTERVAL]: [-4_291_747_199_999_999n, 4_291_747_199_999_999n],
	[Ydb.Type_PrimitiveTypeId.DATE32]: [-53_375_809, 53_375_807],
	[Ydb.Type_PrimitiveTypeId.DATETIME64]: [-4_611_669_897_600n, 4_611_669_811_199n],
	[Ydb.Type_PrimitiveTypeId.TIMESTAMP64]: [
		-4_611_669_897_600_000_000n,
		4_611_669_811_199_999_999n,
	],
	[Ydb.Type_PrimitiveTypeId.INTERVAL64]: [
		-9_223_339_708_799_999_999n,
		9_223_339_708_799_999_999n,
	],
}

export class Primitive implements Value<PrimitiveType> {
	type: PrimitiveType
	value: unknown
	declare high128?: bigint

	// oxlint-disable no-unused-private-class-members
	#value: MessageInitShape<GenMessage<Ydb.Value>>
	#valueInstance?: Ydb.Value

	constructor(value: MessageInitShape<GenMessage<Ydb.Value>>, type: PrimitiveType) {
		let field = primitiveFields[type.id]
		if (!field || value.value?.case !== field) {
			throw new TypeError(
				`Primitive type ${Ydb.Type_PrimitiveTypeId[type.id] ?? type.id} requires ${field ?? 'a supported wire field'}`
			)
		}
		let range = integerRanges[type.id]
		let scalar = value.value?.value
		if (
			range &&
			(typeof scalar !== typeof range[0] ||
				(typeof scalar === 'number' && !Number.isInteger(scalar)) ||
				(scalar as number | bigint) < range[0] ||
				(scalar as number | bigint) > range[1])
		) {
			throw new RangeError(
				`Value is outside the ${Ydb.Type_PrimitiveTypeId[type.id]} integer range`
			)
		}
		this.type = type
		this.value = scalar
		this.#value = value
		if (value.value?.case === 'low128') {
			this.high128 = value.high128 ?? 0n
		}
	}

	encode(): Ydb.Value {
		if (!this.#valueInstance) {
			this.#valueInstance = create(Ydb.ValueSchema, this.#value)
		}

		return this.#valueInstance
	}
}

export class BoolType extends PrimitiveType {
	constructor() {
		super(Ydb.Type_PrimitiveTypeId.BOOL)
	}
}

export class Bool extends Primitive implements Value<BoolType> {
	constructor(value: boolean) {
		super({ value: { case: 'boolValue', value: value } }, new BoolType())
	}

	static from(value: boolean): Bool {
		return new Bool(value)
	}
}

export class Int8Type extends PrimitiveType {
	constructor() {
		super(Ydb.Type_PrimitiveTypeId.INT8)
	}
}

export class Int8 extends Primitive implements Value<Int8Type> {
	constructor(value: number) {
		super({ value: { case: 'int32Value', value: value } }, new Int8Type())
	}
}

export class Uint8Type extends PrimitiveType {
	constructor() {
		super(Ydb.Type_PrimitiveTypeId.UINT8)
	}
}

export class Uint8 extends Primitive implements Value<Uint8Type> {
	constructor(value: number) {
		if (value < 0) {
			throw new Error('Value must be greater than or equal to 0')
		}

		super({ value: { case: 'uint32Value', value: value } }, new Uint8Type())
	}
}

export class Int16Type extends PrimitiveType {
	constructor() {
		super(Ydb.Type_PrimitiveTypeId.INT16)
	}
}

export class Int16 extends Primitive implements Value<Int16Type> {
	constructor(value: number) {
		super({ value: { case: 'int32Value', value: value } }, new Int16Type())
	}
}

export class Uint16Type extends PrimitiveType {
	constructor() {
		super(Ydb.Type_PrimitiveTypeId.UINT16)
	}
}

export class Uint16 extends Primitive implements Value<Uint16Type> {
	constructor(value: number) {
		if (value < 0) {
			throw new Error('Value must be greater than or equal to 0')
		}

		super({ value: { case: 'uint32Value', value: value } }, new Uint16Type())
	}
}

export class Int32Type extends PrimitiveType {
	constructor() {
		super(Ydb.Type_PrimitiveTypeId.INT32)
	}
}

export class Int32 extends Primitive implements Value<Int32Type> {
	constructor(value: number) {
		super({ value: { case: 'int32Value', value: value } }, new Int32Type())
	}
}

export class Uint32Type extends PrimitiveType {
	constructor() {
		super(Ydb.Type_PrimitiveTypeId.UINT32)
	}
}

export class Uint32 extends Primitive implements Value<Uint32Type> {
	constructor(value: number) {
		if (value < 0) {
			throw new Error('Value must be greater than or equal to 0')
		}

		super({ value: { case: 'uint32Value', value: value } }, new Uint32Type())
	}
}

export class Int64Type extends PrimitiveType {
	constructor() {
		super(Ydb.Type_PrimitiveTypeId.INT64)
	}
}

export class Int64 extends Primitive implements Value<Int64Type> {
	constructor(value: bigint) {
		super({ value: { case: 'int64Value', value: value } }, new Int64Type())
	}
}

export class Uint64Type extends PrimitiveType {
	constructor() {
		super(Ydb.Type_PrimitiveTypeId.UINT64)
	}
}

export class Uint64 extends Primitive implements Value<Uint64Type> {
	constructor(value: bigint) {
		if (value < BigInt(0)) {
			throw new Error('Value must be greater than or equal to 0')
		}

		super({ value: { case: 'uint64Value', value: value } }, new Uint64Type())
	}
}

export class FloatType extends PrimitiveType {
	constructor() {
		super(Ydb.Type_PrimitiveTypeId.FLOAT)
	}
}

export class Float extends Primitive implements Value<FloatType> {
	constructor(value: number) {
		super({ value: { case: 'floatValue', value: value } }, new FloatType())
	}
}

export class DoubleType extends PrimitiveType {
	constructor() {
		super(Ydb.Type_PrimitiveTypeId.DOUBLE)
	}
}

export class Double extends Primitive implements Value<DoubleType> {
	constructor(value: number) {
		super({ value: { case: 'doubleValue', value: value } }, new DoubleType())
	}
}

export class BytesType extends PrimitiveType {
	constructor() {
		super(Ydb.Type_PrimitiveTypeId.STRING)
	}
}

export class Bytes extends Primitive implements Value<BytesType> {
	constructor(value: Uint8Array) {
		super({ value: { case: 'bytesValue', value: value } }, new BytesType())
	}
}

export class TextType extends PrimitiveType {
	constructor() {
		super(Ydb.Type_PrimitiveTypeId.UTF8)
	}
}

export class Text extends Primitive implements Value<TextType> {
	constructor(value: string) {
		super({ value: { case: 'textValue', value: value } }, new TextType())
	}
}

export class Utf8Type extends PrimitiveType {
	constructor() {
		super(Ydb.Type_PrimitiveTypeId.UTF8)
	}
}

export class Utf8 extends Primitive implements Value<Utf8Type> {
	constructor(value: string) {
		super({ value: { case: 'textValue', value: value } }, new Utf8Type())
	}
}

export class JsonType extends PrimitiveType {
	constructor() {
		super(Ydb.Type_PrimitiveTypeId.JSON)
	}
}

export class Json extends Primitive implements Value<JsonType> {
	constructor(value: string) {
		super({ value: { case: 'textValue', value: value } }, new JsonType())
	}
}

export class YsonType extends PrimitiveType {
	constructor() {
		super(Ydb.Type_PrimitiveTypeId.YSON)
	}
}

export class Yson extends Primitive implements Value<YsonType> {
	constructor(value: Uint8Array) {
		super({ value: { case: 'bytesValue', value: value } }, new YsonType())
	}
}

export class UuidType extends PrimitiveType {
	constructor() {
		super(Ydb.Type_PrimitiveTypeId.UUID)
	}
}

export class Uuid extends Primitive implements Value<UuidType> {
	low128: bigint = 0n
	override high128: bigint = 0n

	constructor(value: string) {
		let { low128, high128 } = bigIntsFromUuid(value)

		super({ value: { case: 'low128', value: low128 }, high128 }, new UuidType())

		this.low128 = low128
		this.high128 = high128
	}

	override toString(): string {
		return uuidFromBigInts(this.low128, this.high128)
	}
}

export class DateType extends PrimitiveType {
	constructor() {
		super(Ydb.Type_PrimitiveTypeId.DATE)
	}
}

export class Date extends Primitive implements Value<DateType> {
	constructor(value: InstanceType<GenericDateConstructor> | number) {
		let datesFromEpoch =
			typeof value === 'number' ? value : Math.floor(value.getTime() / (24 * 60 * 60 * 1000))

		super({ value: { case: 'uint32Value', value: datesFromEpoch } }, new DateType())
	}
}

export class TzDateType extends PrimitiveType {
	constructor() {
		super(Ydb.Type_PrimitiveTypeId.TZ_DATE)
	}
}

export class TzDate extends Primitive implements Value<TzDateType> {
	constructor(value: TZDate | string) {
		super(
			{ value: { case: 'textValue', value: timezoneText(value, 'date', false) } },
			new TzDateType()
		)
	}
}

export class DatetimeType extends PrimitiveType {
	constructor() {
		super(Ydb.Type_PrimitiveTypeId.DATETIME)
	}
}

export class Datetime extends Primitive implements Value<DatetimeType> {
	constructor(value: InstanceType<GenericDateConstructor> | number) {
		let secondsFromEpoch =
			typeof value === 'number' ? value : Math.floor(value.getTime() / 1000)

		super({ value: { case: 'uint32Value', value: secondsFromEpoch } }, new DatetimeType())
	}
}

export class TzDatetimeType extends PrimitiveType {
	constructor() {
		super(Ydb.Type_PrimitiveTypeId.TZ_DATETIME)
	}
}

export class TzDatetime extends Primitive implements Value<TzDatetimeType> {
	constructor(value: TZDate | string) {
		super(
			{ value: { case: 'textValue', value: timezoneText(value, 'datetime', false) } },
			new TzDatetimeType()
		)
	}
}

export class IntervalType extends PrimitiveType {
	constructor() {
		super(Ydb.Type_PrimitiveTypeId.INTERVAL)
	}
}

export class Interval extends Primitive implements Value<IntervalType> {
	constructor(value: number) {
		if (!Number.isSafeInteger(value)) {
			throw new RangeError('Interval must be a safe integer number of microseconds')
		}

		super({ value: { case: 'int64Value', value: BigInt(value) } }, new IntervalType())
		this.value = value
	}
}

export class TimestampType extends PrimitiveType {
	constructor() {
		super(Ydb.Type_PrimitiveTypeId.TIMESTAMP)
	}
}

export class Timestamp extends Primitive implements Value<TimestampType> {
	constructor(value: InstanceType<GenericDateConstructor> | bigint) {
		let microSecondsFromEpoch =
			typeof value === 'bigint' ? value : BigInt(value.getTime()) * 1000n

		super({ value: { case: 'uint64Value', value: microSecondsFromEpoch } }, new TimestampType())
	}
}

export class TzTimestampType extends PrimitiveType {
	constructor() {
		super(Ydb.Type_PrimitiveTypeId.TZ_TIMESTAMP)
	}
}

export class TzTimestamp extends Primitive implements Value<TzTimestampType> {
	constructor(value: TZDate | string) {
		super(
			{ value: { case: 'textValue', value: timezoneText(value, 'timestamp', false) } },
			new TzTimestampType()
		)
	}
}

export class JsonDocumentType extends PrimitiveType {
	constructor() {
		super(Ydb.Type_PrimitiveTypeId.JSON_DOCUMENT)
	}
}

export class JsonDocument extends Primitive implements Value<JsonDocumentType> {
	constructor(value: string) {
		super({ value: { case: 'textValue', value: value } }, new JsonDocumentType())
	}
}

export class Date32Type extends PrimitiveType {
	constructor() {
		super(Ydb.Type_PrimitiveTypeId.DATE32)
	}
}

export class Date32 extends Primitive implements Value<Date32Type> {
	constructor(value: InstanceType<GenericDateConstructor> | number) {
		let days = typeof value === 'number' ? value : Math.floor(value.getTime() / 86400000)
		super({ value: { case: 'int32Value', value: days } }, new Date32Type())
	}
}

export class Datetime64Type extends PrimitiveType {
	constructor() {
		super(Ydb.Type_PrimitiveTypeId.DATETIME64)
	}
}

export class Datetime64 extends Primitive implements Value<Datetime64Type> {
	constructor(value: InstanceType<GenericDateConstructor> | bigint) {
		let seconds = typeof value === 'bigint' ? value : BigInt(Math.floor(value.getTime() / 1000))
		super({ value: { case: 'int64Value', value: seconds } }, new Datetime64Type())
	}
}

export class Timestamp64Type extends PrimitiveType {
	constructor() {
		super(Ydb.Type_PrimitiveTypeId.TIMESTAMP64)
	}
}

export class Timestamp64 extends Primitive implements Value<Timestamp64Type> {
	constructor(value: InstanceType<GenericDateConstructor> | bigint) {
		let microseconds = typeof value === 'bigint' ? value : BigInt(value.getTime()) * 1000n
		super({ value: { case: 'int64Value', value: microseconds } }, new Timestamp64Type())
	}
}

export class Interval64Type extends PrimitiveType {
	constructor() {
		super(Ydb.Type_PrimitiveTypeId.INTERVAL64)
	}
}

export class Interval64 extends Primitive implements Value<Interval64Type> {
	constructor(value: bigint | number) {
		if (
			typeof value !== 'bigint' &&
			(typeof value !== 'number' || !Number.isSafeInteger(value))
		)
			throw new RangeError('Interval64 requires bigint or a number in the safe integer range')
		super({ value: { case: 'int64Value', value: BigInt(value) } }, new Interval64Type())
	}
}

export class DyNumberType extends PrimitiveType {
	constructor() {
		super(Ydb.Type_PrimitiveTypeId.DYNUMBER)
	}
}

export class DyNumber extends Primitive implements Value<DyNumberType> {
	constructor(value: string) {
		if (typeof value !== 'string') throw new TypeError('DyNumber requires decimal text')
		super({ value: { case: 'textValue', value } }, new DyNumberType())
	}
}

export class TzDate32Type extends PrimitiveType {
	constructor() {
		super(ExtendedPrimitiveTypeId.TZ_DATE32)
	}
}

export class TzDate32 extends Primitive implements Value<TzDate32Type> {
	constructor(value: TZDate | string) {
		super(
			{ value: { case: 'textValue', value: timezoneText(value, 'date', true) } },
			new TzDate32Type()
		)
	}
}

export class TzDatetime64Type extends PrimitiveType {
	constructor() {
		super(ExtendedPrimitiveTypeId.TZ_DATETIME64)
	}
}

export class TzDatetime64 extends Primitive implements Value<TzDatetime64Type> {
	constructor(value: TZDate | string) {
		super(
			{ value: { case: 'textValue', value: timezoneText(value, 'datetime', true) } },
			new TzDatetime64Type()
		)
	}
}

export class TzTimestamp64Type extends PrimitiveType {
	constructor() {
		super(ExtendedPrimitiveTypeId.TZ_TIMESTAMP64)
	}
}

export class TzTimestamp64 extends Primitive implements Value<TzTimestamp64Type> {
	constructor(value: TZDate | string) {
		super(
			{ value: { case: 'textValue', value: timezoneText(value, 'timestamp', true) } },
			new TzTimestamp64Type()
		)
	}
}
