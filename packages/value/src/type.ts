import * as Ydb from "@ydbjs/api/value";

export enum TypeKind {
	PRIMITIVE,
	DECIMAL,
	OPTIONAL,
	LIST,
	TUPLE,
	STRUCT,
	DICT,
	VARIANT,
	VOID,
	NULL,
	PG_TYPE
}

export interface Type {
	kind: TypeKind
	encode(): Ydb.Type
}
