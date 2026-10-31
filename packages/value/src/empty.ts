import { create } from '@bufbuild/protobuf'
import * as Ydb from '@ydbjs/api/value'

import { type Type, TypeKind } from './type.js'
import type { Value } from './value.js'

export class EmptyType implements Type {
	constructor(readonly kind: TypeKind.EMPTY_LIST | TypeKind.EMPTY_DICT) {}

	encode(): Ydb.Type {
		return create(Ydb.TypeSchema, {
			type: {
				case: this.kind === TypeKind.EMPTY_LIST ? 'emptyListType' : 'emptyDictType',
				value: 0,
			},
		})
	}
}

export class Empty implements Value<EmptyType> {
	constructor(readonly type: EmptyType) {}

	encode(): Ydb.Value {
		return create(Ydb.ValueSchema)
	}
}
