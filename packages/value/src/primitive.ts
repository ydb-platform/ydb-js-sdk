import { type MessageInitShape, create } from '@bufbuild/protobuf'
import type { GenMessage } from '@bufbuild/protobuf/codegenv1'
import type { TZDate } from '@date-fns/tz'
import * as Ydb from '@ydbjs/api/value'
import { type GenericDateConstructor, formatISO9075 } from 'date-fns'

import { type Type, TypeKind } from './type.js'
import { bigIntsFromUuid } from './uuid.js'
import { type Value } from './value.js'

export class PrimitiveType implements Type {
	readonly id: Ydb.Type_PrimitiveTypeId
	#type: MessageInitShape<GenMessage<Ydb.Type>>
	#typeInstance?: Ydb.Type

	constructor(typeId: Ydb.Type_PrimitiveTypeId) {
		this.id = typeId
		this.#type = { type: { case: 'typeId', value: typeId } }
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
	high128?: bigint
	#value: MessageInitShape<GenMessage<Ydb.Value>>
	#valueInstance?: Ydb.Value

	constructor(value: MessageInitShape<GenMessage<Ydb.Value>>, typeId: Ydb.Type_PrimitiveTypeId) {
		this.type = new PrimitiveType(typeId)
		this.#value = value
	}

	get value(): unknown {
		return this.#value.value?.value
	}

	encode(): Ydb.Value {
		if (!this.#valueInstance) {
			this.#valueInstance = create(Ydb.ValueSchema, this.#value)
		}

		return this.#valueInstance
	}
}

export class Bool extends Primitive implements Value<PrimitiveType> {
	constructor(value: boolean) {
		super({ value: { case: 'boolValue', value: value } }, Ydb.Type_PrimitiveTypeId.BOOL)
	}

	static from(value: boolean): Bool {
		return new Bool(value)
	}
}

export class Int8 extends Primitive implements Value<PrimitiveType> {
	constructor(value: number) {
		super({ value: { case: 'int32Value', value: value } }, Ydb.Type_PrimitiveTypeId.INT8)
	}
}

export class Uint8 extends Primitive implements Value<PrimitiveType> {
	constructor(value: number) {
		if (value < 0) {
			throw new Error('Value must be greater than or equal to 0')
		}

		super({ value: { case: 'uint32Value', value: value } }, Ydb.Type_PrimitiveTypeId.UINT8)
	}
}

export class Int16 extends Primitive implements Value<PrimitiveType> {
	constructor(value: number) {
		super({ value: { case: 'int32Value', value: value } }, Ydb.Type_PrimitiveTypeId.INT16)
	}
}

export class Uint16 extends Primitive implements Value<PrimitiveType> {
	constructor(value: number) {
		if (value < 0) {
			throw new Error('Value must be greater than or equal to 0')
		}

		super({ value: { case: 'uint32Value', value: value } }, Ydb.Type_PrimitiveTypeId.UINT16)
	}
}

export class Int32 extends Primitive implements Value<PrimitiveType> {
	constructor(value: number) {
		super({ value: { case: 'int32Value', value: value } }, Ydb.Type_PrimitiveTypeId.INT32)
	}
}

export class Uint32 extends Primitive implements Value<PrimitiveType> {
	constructor(value: number) {
		if (value < 0) {
			throw new Error('Value must be greater than or equal to 0')
		}

		super({ value: { case: 'uint32Value', value: value } }, Ydb.Type_PrimitiveTypeId.UINT32)
	}
}

export class Int64 extends Primitive implements Value<PrimitiveType> {
	constructor(value: bigint) {
		super({ value: { case: 'int64Value', value: value } }, Ydb.Type_PrimitiveTypeId.INT64)
	}
}

export class Uint64 extends Primitive implements Value<PrimitiveType> {
	constructor(value: bigint) {
		if (value < BigInt(0)) {
			throw new Error('Value must be greater than or equal to 0')
		}

		super({ value: { case: 'uint64Value', value: value } }, Ydb.Type_PrimitiveTypeId.UINT64)
	}
}

export class Float extends Primitive implements Value<PrimitiveType> {
	constructor(value: number) {
		super({ value: { case: 'floatValue', value: value } }, Ydb.Type_PrimitiveTypeId.FLOAT)
	}
}

export class Double extends Primitive implements Value<PrimitiveType> {
	constructor(value: number) {
		super({ value: { case: 'doubleValue', value: value } }, Ydb.Type_PrimitiveTypeId.DOUBLE)
	}
}

export class Bytes extends Primitive implements Value<PrimitiveType> {
	constructor(value: Uint8Array) {
		super({ value: { case: 'bytesValue', value: value } }, Ydb.Type_PrimitiveTypeId.STRING)
	}
}

export class Text extends Primitive implements Value<PrimitiveType> {
	constructor(value: string) {
		super({ value: { case: 'textValue', value: value } }, Ydb.Type_PrimitiveTypeId.UTF8)
	}
}

export class Json extends Primitive implements Value<PrimitiveType> {
	constructor(value: string) {
		super({ value: { case: 'textValue', value: value } }, Ydb.Type_PrimitiveTypeId.JSON)
	}
}

export class Yson extends Primitive implements Value<PrimitiveType> {
	constructor(value: Uint8Array) {
		super({ value: { case: 'bytesValue', value: value } }, Ydb.Type_PrimitiveTypeId.YSON)
	}
}

export class Uuid extends Primitive implements Value<PrimitiveType> {
	override high128: bigint = 0n

	constructor(value: string) {
		let { low128, high128 } = bigIntsFromUuid(value)

		super({ value: { case: 'low128', value: low128 }, high128 }, Ydb.Type_PrimitiveTypeId.UUID)

		this.high128 = high128
	}
}

export class Date extends Primitive implements Value<PrimitiveType> {
	constructor(value: InstanceType<GenericDateConstructor>) {
		let datesFromEpoch = Math.floor(value.getTime() / (24 * 60 * 60 * 1000))

		super({ value: { case: 'uint32Value', value: datesFromEpoch } }, Ydb.Type_PrimitiveTypeId.DATE)
	}
}

export class TzDate extends Primitive implements Value<PrimitiveType> {
	constructor(value: TZDate) {
		let date = formatISO9075(value, { representation: 'date' })

		super({ value: { case: 'textValue', value: `${date},${value.timeZone}` } }, Ydb.Type_PrimitiveTypeId.TZ_DATE)
	}
}

export class Datetime extends Primitive implements Value<PrimitiveType> {
	constructor(value: InstanceType<GenericDateConstructor>) {
		let secondsFromEpoch = Math.floor(value.getTime() / 1000)

		super({ value: { case: 'uint32Value', value: secondsFromEpoch } }, Ydb.Type_PrimitiveTypeId.DATETIME)
	}
}

export class TzDatetime extends Primitive implements Value<PrimitiveType> {
	constructor(value: TZDate) {
		let date = formatISO9075(value, { representation: 'date' })
		let time = formatISO9075(value, { representation: 'time' })

		super(
			{ value: { case: 'textValue', value: `${date}T${time},${value.timeZone}` } },
			Ydb.Type_PrimitiveTypeId.TZ_DATETIME
		)
	}
}

export class Interval extends Primitive implements Value<PrimitiveType> {
	constructor(value: number) {
		super({ value: { case: 'int32Value', value: value } }, Ydb.Type_PrimitiveTypeId.INTERVAL)
	}
}

export class Timestamp extends Primitive implements Value<PrimitiveType> {
	constructor(value: InstanceType<GenericDateConstructor>) {
		let microSecondsFromEpoch = BigInt(value.getTime()) * 1000n

		super({ value: { case: 'uint64Value', value: microSecondsFromEpoch } }, Ydb.Type_PrimitiveTypeId.TIMESTAMP)
	}
}

export class TzTimestamp extends Primitive implements Value<PrimitiveType> {
	constructor(value: TZDate) {
		let date = formatISO9075(value, { representation: 'date' })
		let time = formatISO9075(value, { representation: 'time' })
		let micro = value.getMilliseconds() * 1000

		super(
			{ value: { case: 'textValue', value: `${date}T${time}.${micro},${value.timeZone}` } },
			Ydb.Type_PrimitiveTypeId.TZ_TIMESTAMP
		)
	}
}

export class JsonDocument extends Primitive implements Value<PrimitiveType> {
	constructor(value: string) {
		super({ value: { case: 'textValue', value: value } }, Ydb.Type_PrimitiveTypeId.JSON_DOCUMENT)
	}
}
