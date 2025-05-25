import { type MessageInitShape, create } from '@bufbuild/protobuf'
import type { GenMessage } from '@bufbuild/protobuf/codegenv1'
import type { TZDate } from '@date-fns/tz'
import * as Ydb from '@ydbjs/api/value'
import { type GenericDateConstructor, formatISO9075 } from 'date-fns'

import { type Type, TypeKind } from './type.js'
import { bigIntsFromUuid } from './uuid.js'
import { type Value } from './value.js'

export class PrimitiveType implements Type {
	declare id: Ydb.Type_PrimitiveTypeId

	#type: MessageInitShape<GenMessage<Ydb.Type>>
	#typeInstance?: Ydb.Type

	constructor(typeId: Ydb.Type_PrimitiveTypeId) {
		this.#type = { type: { case: 'typeId', value: typeId } }

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

export class Primitive implements Value<PrimitiveType> {
	type: PrimitiveType
	value: unknown
	high128?: bigint

	// oxlint-disable no-unused-private-class-members
	#value: MessageInitShape<GenMessage<Ydb.Value>>
	#valueInstance?: Ydb.Value

	constructor(value: MessageInitShape<GenMessage<Ydb.Value>>, type: PrimitiveType) {
		this.type = type
		this.value = value?.value?.value
		this.#value = value
		this.high128 = value.high128
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
	override high128: bigint = 0n

	constructor(value: string) {
		let { low128, high128 } = bigIntsFromUuid(value)

		super({ value: { case: 'low128', value: low128 }, high128 }, new UuidType())

		this.high128 = high128
	}
}

export class DateType extends PrimitiveType {
	constructor() {
		super(Ydb.Type_PrimitiveTypeId.DATE)
	}
}

export class Date extends Primitive implements Value<DateType> {
	constructor(value: InstanceType<GenericDateConstructor>) {
		let datesFromEpoch = Math.floor(value.getTime() / (24 * 60 * 60 * 1000))

		super({ value: { case: 'uint32Value', value: datesFromEpoch } }, new DateType())
	}
}

export class TzDateType extends PrimitiveType {
	constructor() {
		super(Ydb.Type_PrimitiveTypeId.TZ_DATE)
	}
}

export class TzDate extends Primitive implements Value<TzDateType> {
	constructor(value: TZDate) {
		let date = formatISO9075(value, { representation: 'date' })

		super({ value: { case: 'textValue', value: `${date},${value.timeZone}` } }, new TzDateType())
	}
}

export class DatetimeType extends PrimitiveType {
	constructor() {
		super(Ydb.Type_PrimitiveTypeId.DATETIME)
	}
}

export class Datetime extends Primitive implements Value<DatetimeType> {
	constructor(value: InstanceType<GenericDateConstructor>) {
		let secondsFromEpoch = Math.floor(value.getTime() / 1000)

		super({ value: { case: 'uint32Value', value: secondsFromEpoch } }, new DatetimeType())
	}
}

export class TzDatetimeType extends PrimitiveType {
	constructor() {
		super(Ydb.Type_PrimitiveTypeId.TZ_DATETIME)
	}
}

export class TzDatetime extends Primitive implements Value<TzDatetimeType> {
	constructor(value: TZDate) {
		let date = formatISO9075(value, { representation: 'date' })
		let time = formatISO9075(value, { representation: 'time' })

		super({ value: { case: 'textValue', value: `${date}T${time},${value.timeZone}` } }, new TzDatetimeType())
	}
}

export class IntervalType extends PrimitiveType {
	constructor() {
		super(Ydb.Type_PrimitiveTypeId.INTERVAL)
	}
}

export class Interval extends Primitive implements Value<IntervalType> {
	constructor(value: number) {
		super({ value: { case: 'int32Value', value: value } }, new IntervalType())
	}
}

export class TimestampType extends PrimitiveType {
	constructor() {
		super(Ydb.Type_PrimitiveTypeId.TIMESTAMP)
	}
}

export class Timestamp extends Primitive implements Value<TimestampType> {
	constructor(value: InstanceType<GenericDateConstructor>) {
		let microSecondsFromEpoch = BigInt(value.getTime()) * 1000n

		super({ value: { case: 'uint64Value', value: microSecondsFromEpoch } }, new TimestampType())
	}
}

export class TzTimestampType extends PrimitiveType {
	constructor() {
		super(Ydb.Type_PrimitiveTypeId.TZ_TIMESTAMP)
	}
}

export class TzTimestamp extends Primitive implements Value<TzTimestampType> {
	constructor(value: TZDate) {
		let date = formatISO9075(value, { representation: 'date' })
		let time = formatISO9075(value, { representation: 'time' })
		let micro = value.getMilliseconds() * 1000

		super({ value: { case: 'textValue', value: `${date}T${time}.${micro},${value.timeZone}` } }, new TzTimestampType())
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
