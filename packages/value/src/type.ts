import * as Ydb from '@ydbjs/api/value'

export enum TypeKind {
	PRIMITIVE = 1,
	DECIMAL = 2,
	OPTIONAL = 3,
	LIST = 4,
	TUPLE = 5,
	STRUCT = 6,
	DICT = 7,
	VARIANT = 8,
	VOID = 9,
	NULL = 10,
	PG_TYPE = 11,
	EMPTY_LIST = 12,
	EMPTY_DICT = 13,
	TAGGED = 14,
}

export interface Type {
	kind: TypeKind
	encode(): Ydb.Type
}
