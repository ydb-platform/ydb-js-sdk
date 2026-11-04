import * as Ydb from '@ydbjs/api/value'

export enum TypeKind {
	PRIMITIVE = 1,
	DECIMAL = 2,
	OPTIONAL = 3,
	LIST = 4,
	TUPLE = 5,
	STRUCT = 6,
	DICT = 7,
	NULL = 10,
	EMPTY_LIST = 12,
	EMPTY_DICT = 13,
}

export interface Type {
	kind: TypeKind
	encode(): Ydb.Type
}
