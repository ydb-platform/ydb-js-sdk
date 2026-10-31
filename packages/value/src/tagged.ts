import { create } from '@bufbuild/protobuf'
import * as Ydb from '@ydbjs/api/value'

import { assertType } from './type-check.js'
import { type Type, TypeKind } from './type.js'
import type { Value } from './value.js'

export class TaggedType implements Type {
	readonly tag: string
	readonly itemType: Type
	#typeInstance?: Ydb.Type

	constructor(tag: string, itemType: Type) {
		if (typeof tag !== 'string') throw new TypeError('Tagged type requires a string tag')
		if (!itemType || typeof itemType.encode !== 'function') {
			throw new TypeError('Tagged type requires an item type')
		}
		this.tag = tag
		this.itemType = itemType
	}

	get kind(): TypeKind.TAGGED {
		return TypeKind.TAGGED
	}

	encode(): Ydb.Type {
		if (!this.#typeInstance) {
			this.#typeInstance = create(Ydb.TypeSchema, {
				type: {
					case: 'taggedType',
					value: { tag: this.tag, type: this.itemType.encode() },
				},
			})
		}
		return this.#typeInstance
	}
}

export class Tagged<T extends Value = Value> implements Value<TaggedType> {
	readonly type: TaggedType
	readonly item: T

	constructor(item: T, tagOrType: string | TaggedType) {
		if (!item || typeof item.encode !== 'function') {
			throw new TypeError('Tagged item must be a typed Value')
		}
		if (typeof tagOrType === 'string') {
			this.type = new TaggedType(tagOrType, item.type)
		} else {
			if (!(tagOrType instanceof TaggedType)) {
				throw new TypeError('Tagged requires a string tag or TaggedType')
			}
			assertType(item.type, tagOrType.itemType, 'Tagged item')
			this.type = tagOrType
		}
		this.item = item
	}

	encode(): Ydb.Value {
		return this.item.encode()
	}
}
