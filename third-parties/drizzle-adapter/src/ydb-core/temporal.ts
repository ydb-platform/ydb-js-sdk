import { Type_PrimitiveTypeId } from '@ydbjs/api/value'
import { Primitive } from '@ydbjs/value/primitive'

export function dateFromDriver(value: Date | Primitive): Date {
	if (value instanceof Date) return value
	if (value instanceof Primitive) {
		switch (value.type.id) {
			case Type_PrimitiveTypeId.DATE:
			case Type_PrimitiveTypeId.DATE32:
				return new Date(Number(value.value) * 86_400_000)
			case Type_PrimitiveTypeId.DATETIME:
			case Type_PrimitiveTypeId.DATETIME64:
				return new Date(Number(value.value) * 1000)
			case Type_PrimitiveTypeId.TIMESTAMP:
			case Type_PrimitiveTypeId.TIMESTAMP64:
				return new Date(Number((value.value as bigint) / 1000n))
			default:
				throw new TypeError('Expected a YDB date or timestamp value')
		}
	}
	throw new TypeError('Expected a Date or YDB date value')
}
