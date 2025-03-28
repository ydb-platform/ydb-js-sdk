import * as Ydb from "@ydbjs/api/value";

import { TypeKind, type Type } from "./type.js";
import type { PrimitiveType } from "./primitive.js";
import type { ListType } from "./list.js";
import type { DictType } from "./dict.js";
import type { TupleType } from "./tuple.js";
import type { StructType } from "./struct.js";

function primitiveTypeToString(pTypeId: Ydb.Type_PrimitiveTypeId) {
	switch (pTypeId) {
		case Ydb.Type_PrimitiveTypeId.BOOL:
			return "Bool";
		case Ydb.Type_PrimitiveTypeId.UINT8:
			return "Uint8";
		case Ydb.Type_PrimitiveTypeId.UINT16:
			return "Uint16";
		case Ydb.Type_PrimitiveTypeId.UINT32:
			return "Uint32";
		case Ydb.Type_PrimitiveTypeId.UINT64:
			return "Uint64";
		case Ydb.Type_PrimitiveTypeId.INT8:
			return "Int8";
		case Ydb.Type_PrimitiveTypeId.INT16:
			return "Int16";
		case Ydb.Type_PrimitiveTypeId.INT32:
			return "Int32";
		case Ydb.Type_PrimitiveTypeId.INT64:
			return "Int64";
		case Ydb.Type_PrimitiveTypeId.FLOAT:
			return "Float";
		case Ydb.Type_PrimitiveTypeId.DOUBLE:
			return "Double";
		case Ydb.Type_PrimitiveTypeId.STRING:
			return "String";
		case Ydb.Type_PrimitiveTypeId.UTF8:
			return "Utf8";
		case Ydb.Type_PrimitiveTypeId.YSON:
			return "Yson";
		case Ydb.Type_PrimitiveTypeId.JSON:
			return "Json";
		case Ydb.Type_PrimitiveTypeId.JSON_DOCUMENT:
			return "JsonDocument";
		case Ydb.Type_PrimitiveTypeId.UUID:
			return "Uuid";
		case Ydb.Type_PrimitiveTypeId.DATE:
			return "Date";
		case Ydb.Type_PrimitiveTypeId.TZ_DATE:
			return "TzDate";
		case Ydb.Type_PrimitiveTypeId.DATETIME:
			return "Datetime";
		case Ydb.Type_PrimitiveTypeId.TZ_DATETIME:
			return "TzDatetime";
		case Ydb.Type_PrimitiveTypeId.INTERVAL:
			return "Interval";
		case Ydb.Type_PrimitiveTypeId.TIMESTAMP:
			return "Timestamp";
		case Ydb.Type_PrimitiveTypeId.TZ_TIMESTAMP:
			return "TzTimestamp";
		case Ydb.Type_PrimitiveTypeId.DYNUMBER:
			return "DyNumber";
		default:
			throw new Error(`Unknown primitive type id: ${pTypeId}`);
	}
}

export function typeToString(type: Type): string {
	switch (type.kind) {
		case TypeKind.PRIMITIVE:
			return primitiveTypeToString((type as PrimitiveType).id);
		case TypeKind.DECIMAL:
			return "Decimal";
		case TypeKind.LIST:
			return `List<${typeToString((type as ListType).item)}>`;
		case TypeKind.DICT:
			return `Dict<${typeToString((type as DictType).key)},${typeToString((type as DictType).value)}>`;
		case TypeKind.TUPLE:
			return `Tuple<${(type as TupleType).elements.map((element) => typeToString(element)).join(",")}>`;
		case TypeKind.STRUCT:
			return `Struct<${(type as StructType).names.map((name, index) => `${name}:${typeToString((type as StructType).types[index])}`).join(",")}>`;
		case TypeKind.NULL:
			return "Null";
	}

	throw new Error(`Unsupported type: ${type}`);
}
