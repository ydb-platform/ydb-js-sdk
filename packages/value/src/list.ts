import { create } from '@bufbuild/protobuf'
import * as Ydb from '@ydbjs/api/value'

import { type Type, TypeKind } from './type.js'
import type { Value } from './value.js'
import { NullType } from './null.js'
import { assertType } from './type-check.js'

export class ListType implements Type {
	readonly item: Type
	#typeInstance?: Ydb.Type

	constructor(item: Type) {
		this.item = item
	}

	get kind(): TypeKind.LIST {
		return TypeKind.LIST
	}

	encode(): Ydb.Type {
		if (!this.#typeInstance) {
			this.#typeInstance = create(Ydb.TypeSchema, {
				type: { case: 'listType', value: { item: this.item.encode() } },
			})
		}

		return this.#typeInstance
	}
}

export class List<T extends Value = Value> implements Value<ListType> {
	readonly type: ListType
	readonly items: T[] = []
	#valueInstance?: Ydb.Value

	constructor(...items: T[])
	constructor(items: T[], type: ListType)
	constructor(...args: T[] | [T[], ListType]) {
		let explicit = Array.isArray(args[0])
		let items = (explicit ? args[0] : args) as T[]
		this.type = explicit
			? (args[1] as ListType)
			: new ListType(items[0]?.type ?? new NullType())
		for (let [index, item] of items.entries()) {
			assertType(item.type, this.type.item, `List item ${index}`)
			this.items.push(item)
		}
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
