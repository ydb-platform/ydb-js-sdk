import * as Ydb from '@ydbjs/api/value'

import type { DecimalType } from './decimal.js'
import type { DictType } from './dict.js'
import type { ListType } from './list.js'
import type { OptionalType } from './optional.ts'
import { ExtendedPrimitiveTypeId, type PrimitiveTypeId } from './primitive.js'
import type { PgType } from './pg.js'
import type { TaggedType } from './tagged.js'
import type { VariantType } from './variant.js'
import type { PrimitiveType } from './primitive.js'
import type { StructType } from './struct.js'
import type { TupleType } from './tuple.js'
import { type Type, TypeKind } from './type.js'

function primitiveTypeToString(pTypeId: PrimitiveTypeId) {
	switch (pTypeId) {
		case Ydb.Type_PrimitiveTypeId.BOOL:
			return 'Bool'
		case Ydb.Type_PrimitiveTypeId.UINT8:
			return 'Uint8'
		case Ydb.Type_PrimitiveTypeId.UINT16:
			return 'Uint16'
		case Ydb.Type_PrimitiveTypeId.UINT32:
			return 'Uint32'
		case Ydb.Type_PrimitiveTypeId.UINT64:
			return 'Uint64'
		case Ydb.Type_PrimitiveTypeId.INT8:
			return 'Int8'
		case Ydb.Type_PrimitiveTypeId.INT16:
			return 'Int16'
		case Ydb.Type_PrimitiveTypeId.INT32:
			return 'Int32'
		case Ydb.Type_PrimitiveTypeId.INT64:
			return 'Int64'
		case Ydb.Type_PrimitiveTypeId.FLOAT:
			return 'Float'
		case Ydb.Type_PrimitiveTypeId.DOUBLE:
			return 'Double'
		case Ydb.Type_PrimitiveTypeId.STRING:
			return 'String'
		case Ydb.Type_PrimitiveTypeId.UTF8:
			return 'Utf8'
		case Ydb.Type_PrimitiveTypeId.YSON:
			return 'Yson'
		case Ydb.Type_PrimitiveTypeId.JSON:
			return 'Json'
		case Ydb.Type_PrimitiveTypeId.JSON_DOCUMENT:
			return 'JsonDocument'
		case Ydb.Type_PrimitiveTypeId.UUID:
			return 'Uuid'
		case Ydb.Type_PrimitiveTypeId.DATE:
			return 'Date'
		case Ydb.Type_PrimitiveTypeId.TZ_DATE:
			return 'TzDate'
		case Ydb.Type_PrimitiveTypeId.DATETIME:
			return 'Datetime'
		case Ydb.Type_PrimitiveTypeId.TZ_DATETIME:
			return 'TzDatetime'
		case Ydb.Type_PrimitiveTypeId.INTERVAL:
			return 'Interval'
		case Ydb.Type_PrimitiveTypeId.TIMESTAMP:
			return 'Timestamp'
		case Ydb.Type_PrimitiveTypeId.TZ_TIMESTAMP:
			return 'TzTimestamp'
		case Ydb.Type_PrimitiveTypeId.DATE32:
			return 'Date32'
		case Ydb.Type_PrimitiveTypeId.DATETIME64:
			return 'Datetime64'
		case Ydb.Type_PrimitiveTypeId.TIMESTAMP64:
			return 'Timestamp64'
		case Ydb.Type_PrimitiveTypeId.INTERVAL64:
			return 'Interval64'
		case Ydb.Type_PrimitiveTypeId.DYNUMBER:
			return 'DyNumber'
		case ExtendedPrimitiveTypeId.TZ_DATE32:
			return 'TzDate32'
		case ExtendedPrimitiveTypeId.TZ_DATETIME64:
			return 'TzDatetime64'
		case ExtendedPrimitiveTypeId.TZ_TIMESTAMP64:
			return 'TzTimestamp64'
		default:
			throw new Error(`Unknown primitive type id: ${pTypeId}`)
	}
}

function memberName(name: string): string {
	return /^[A-Za-z_][A-Za-z_0-9]*$/.test(name)
		? name
		: '`' + name.replaceAll('\\', '\\\\').replaceAll('`', '``') + '`'
}

export function typeToString(type: Type): string {
	switch (type.kind) {
		case TypeKind.PRIMITIVE:
			return primitiveTypeToString((type as PrimitiveType).id)
		case TypeKind.DECIMAL:
			return `Decimal(${(type as DecimalType).precision},${(type as DecimalType).scale})`
		case TypeKind.LIST:
			return `List<${typeToString((type as ListType).item)}>`
		case TypeKind.DICT:
			return `Dict<${typeToString((type as DictType).key)},${typeToString((type as DictType).value)}>`
		case TypeKind.TUPLE:
			return `Tuple<${(type as TupleType).elements.map((element) => typeToString(element)).join(',')}>`
		case TypeKind.STRUCT:
			return `Struct<${(type as StructType).names.map((name, index) => `${memberName(name)}:${typeToString((type as StructType).types[index]!)}`).join(',')}>`
		case TypeKind.VARIANT: {
			let items = (type as VariantType).items
			let body = typeToString(items)
			return `Variant<${body.slice(body.indexOf('<') + 1, -1)}>`
		}
		case TypeKind.TAGGED:
			return `Tagged<${typeToString((type as TaggedType).itemType)},${JSON.stringify((type as TaggedType).tag)}>`
		case TypeKind.VOID:
			return 'Void'
		case TypeKind.PG_TYPE: {
			let name = (type as PgType).typeName
			if (!/^_?pg[a-z][a-z0-9_]*$/.test(name))
				throw new TypeError(
					'A canonical Pg typeName is required for SQL declarations; use QueryClient with an explicit DECLARE for OID-only types'
				)
			return name
		}
		case TypeKind.OPTIONAL:
			return `Optional<${typeToString((type as OptionalType).itemType)}>`
		case TypeKind.EMPTY_LIST:
			return 'EmptyList'
		case TypeKind.EMPTY_DICT:
			return 'EmptyDict'
		case TypeKind.NULL:
			return 'Null'
		default:
			throw new Error(`Unsupported type: ${type}`)
	}
}
