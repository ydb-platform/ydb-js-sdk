import { create } from '@bufbuild/protobuf'
import * as Ydb from '@ydbjs/api/value'

import { type Type, TypeKind } from './type.js'
import type { Value } from './value.js'

export class VoidType implements Type {
	#typeInstance?: Ydb.Type

	get kind(): TypeKind.VOID {
		return TypeKind.VOID
	}

	encode(): Ydb.Type {
		if (!this.#typeInstance) {
			this.#typeInstance = create(Ydb.TypeSchema, {
				type: { case: 'voidType', value: 0 },
			})
		}
		return this.#typeInstance
	}
}

export class Void implements Value<VoidType> {
	readonly type: VoidType = new VoidType()
	#valueInstance?: Ydb.Value

	encode(): Ydb.Value {
		if (!this.#valueInstance) this.#valueInstance = create(Ydb.ValueSchema)
		return this.#valueInstance
	}
}
