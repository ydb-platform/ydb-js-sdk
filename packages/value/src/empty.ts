import { create } from '@bufbuild/protobuf'
import * as Ydb from '@ydbjs/api/value'

import { type Type, TypeKind } from './type.js'
import type { Value } from './value.js'

export class EmptyType implements Type {
	constructor(readonly kind: TypeKind.EMPTY_LIST | TypeKind.EMPTY_DICT) {
		if (kind !== TypeKind.EMPTY_LIST && kind !== TypeKind.EMPTY_DICT)
			throw new TypeError('EmptyType requires EmptyList or EmptyDict')
	}

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
	constructor(readonly type: EmptyType) {
		if (!(type instanceof EmptyType)) throw new TypeError('Empty value requires an EmptyType')
	}

	encode(): Ydb.Value {
		return create(Ydb.ValueSchema)
	}
}

export class EmptyListType extends EmptyType {
	constructor() {
		super(TypeKind.EMPTY_LIST)
	}
}

export class EmptyDictType extends EmptyType {
	constructor() {
		super(TypeKind.EMPTY_DICT)
	}
}

export class EmptyList extends Empty {
	constructor() {
		super(new EmptyListType())
	}
}

export class EmptyDict extends Empty {
	constructor() {
		super(new EmptyDictType())
	}
}
