import { create } from '@bufbuild/protobuf'
import * as Ydb from '@ydbjs/api/value'

import { StructType } from './struct.js'
import { TupleType } from './tuple.js'
import { assertType } from './type-check.js'
import { type Type, TypeKind } from './type.js'
import type { Value } from './value.js'

export class VariantType implements Type {
	readonly items: TupleType | StructType
	#typeInstance?: Ydb.Type

	constructor(items: TupleType | StructType) {
		if (!(items instanceof TupleType) && !(items instanceof StructType)) {
			throw new TypeError('Variant type requires a TupleType or StructType')
		}
		let count = items instanceof TupleType ? items.elements.length : items.names.length
		if (!count) throw new TypeError('Variant type requires at least one alternative')
		this.items = items
	}

	get kind(): TypeKind.VARIANT {
		return TypeKind.VARIANT
	}

	encode(): Ydb.Type {
		if (!this.#typeInstance) {
			let items = this.items.encode().type
			if (items.case !== 'tupleType' && items.case !== 'structType') {
				throw new TypeError('Variant alternatives must encode as a Tuple or Struct type')
			}
			this.#typeInstance = create(Ydb.TypeSchema, {
				type: {
					case: 'variantType',
					value: {
						type:
							items.case === 'tupleType'
								? { case: 'tupleItems', value: items.value }
								: { case: 'structItems', value: items.value },
					},
				},
			})
		}
		return this.#typeInstance
	}
}

export class Variant<T extends Value = Value> implements Value<VariantType> {
	readonly type: VariantType
	readonly item: T
	readonly tag: number | string
	readonly index: number
	#valueInstance?: Ydb.Value

	constructor(item: T, tag: number | string, type: VariantType) {
		if (!(type instanceof VariantType)) throw new TypeError('Variant requires a VariantType')
		let itemType: Type
		if (type.items instanceof TupleType) {
			if (typeof tag !== 'number' || !Number.isInteger(tag)) {
				throw new TypeError('Tuple variant requires an integer alternative index')
			}
			if (tag < 0 || tag >= type.items.elements.length) {
				throw new RangeError(`Variant alternative index ${tag} is out of range`)
			}
			this.index = tag
			itemType = type.items.elements[tag]!
		} else {
			if (typeof tag !== 'string') {
				throw new TypeError('Struct variant requires an alternative name')
			}
			this.index = type.items.names.indexOf(tag)
			if (this.index === -1) throw new RangeError(`Unknown variant alternative: ${tag}`)
			itemType = type.items.types[this.index]!
		}
		if (!item || typeof item.encode !== 'function') {
			throw new TypeError('Variant item must be a typed Value')
		}
		assertType(item.type, itemType, `Variant alternative ${tag}`)
		this.type = type
		this.item = item
		this.tag = tag
	}

	encode(): Ydb.Value {
		if (!this.#valueInstance) {
			this.#valueInstance = create(Ydb.ValueSchema, {
				value: { case: 'nestedValue', value: this.item.encode() },
				variantIndex: this.index,
			})
		}
		return this.#valueInstance
	}
}
