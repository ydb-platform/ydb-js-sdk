import { create } from '@bufbuild/protobuf'
import * as Ydb from '@ydbjs/api/value'

import { type Type, TypeKind } from './type.js'
import type { Value } from './value.js'

export class TupleType implements Type {
	readonly elements: Type[]
	#typeInstance?: Ydb.Type

	constructor(elements: Type[]) {
		this.elements = elements
	}

	get kind(): TypeKind.TUPLE {
		return TypeKind.TUPLE
	}

	encode(): Ydb.Type {
		if (!this.#typeInstance) {
			this.#typeInstance = create(Ydb.TypeSchema, {
				type: {
					case: 'tupleType',
					value: { elements: this.elements.map((e) => e.encode()) },
				},
			})
		}

		return this.#typeInstance
	}
}

export class Tuple<T extends Value = Value> implements Value<TupleType> {
	readonly type: TupleType
	readonly items: T[] = []
	#valueInstance?: Ydb.Value

	constructor(...items: T[]) {
		let elements: Type[] = []

		for (let item of items) {
			this.items.push(item)
			elements.push(item.type)
		}

		this.type = new TupleType(elements)
	}

	encode(): Ydb.Value {
		if (!this.#valueInstance) {
			this.#valueInstance = create(Ydb.ValueSchema, {
				items: this.items.map((item) => item.encode()),
			})
		}

		return this.#valueInstance
	}

	*[Symbol.iterator](): Iterator<T> {
		for (let i = 0; i < this.items.length; i++) {
			yield this.items[i]!
		}
	}
}
