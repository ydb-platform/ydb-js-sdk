import { create } from '@bufbuild/protobuf'
import * as Ydb from '@ydbjs/api/value'

import { type Type, TypeKind } from './type.js'
import type { Value } from './value.js'
import { NullType } from './null.js'
import { assertType } from './type-check.js'

export class DictType implements Type {
	readonly key: Type
	readonly value: Type
	#typeInstance?: Ydb.Type

	constructor(keyType: Type, valueType: Type) {
		this.key = keyType
		this.value = valueType
	}

	get kind(): TypeKind.DICT {
		return TypeKind.DICT
	}

	encode(): Ydb.Type {
		if (!this.#typeInstance) {
			this.#typeInstance = create(Ydb.TypeSchema, {
				type: {
					case: 'dictType',
					value: {
						key: this.key.encode(),
						payload: this.value.encode(),
					},
				},
			})
		}

		return this.#typeInstance
	}
}

export class Dict<K extends Value = Value, V extends Value = Value> implements Value<DictType> {
	readonly type: DictType
	readonly pairs: [K, V][] = []
	#valueInstance?: Ydb.Value

	constructor(...items: [K, V][])
	constructor(items: [K, V][], type: DictType)
	constructor(...args: [K, V][] | [[K, V][], DictType]) {
		let explicit = args[1] instanceof DictType
		let items = (explicit ? args[0] : args) as [K, V][]
		this.type = explicit
			? (args[1] as DictType)
			: new DictType(
					items[0]?.[0].type ?? new NullType(),
					items[0]?.[1].type ?? new NullType()
				)
		for (let [index, [key, value]] of items.entries()) {
			assertType(key.type, this.type.key, `Dict key ${index}`)
			assertType(value.type, this.type.value, `Dict value ${index}`)
			this.pairs.push([key, value])
		}
	}

	encode(): Ydb.Value {
		if (!this.#valueInstance) {
			let pairs: { key: Ydb.Value; payload: Ydb.Value }[] = []

			for (let [k, v] of this.pairs) {
				pairs.push({ key: k.encode(), payload: v.encode() })
			}

			this.#valueInstance = create(Ydb.ValueSchema, { pairs })
		}

		return this.#valueInstance
	}

	*[Symbol.iterator](): Iterator<[K, V]> {
		for (let i = 0; i < this.pairs.length; i++) {
			yield this.pairs[i]!
		}
	}
}
