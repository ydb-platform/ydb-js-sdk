import { create } from '@bufbuild/protobuf';
import * as Ydb from '@ydbjs/api/value'

import { TypeKind, type Type } from "./type.js";
import type { Value } from './value.js';
import { NullType } from './null.js';

export class DictType implements Type {
	readonly key: Type;
	readonly value: Type;
	#typeInstance?: Ydb.Type;

	constructor(keyType: Type, valueType: Type) {
		this.key = keyType;
		this.value = valueType;
	}

	get kind(): TypeKind.DICT {
		return TypeKind.DICT;
	}

	encode(): Ydb.Type {
		if (!this.#typeInstance) {
			this.#typeInstance = create(Ydb.TypeSchema, { type: { case: 'dictType', value: { key: this.key.encode(), payload: this.value.encode() } } });
		}

		return this.#typeInstance;
	}
}

export class Dict<K extends Value = Value, V extends Value = Value> implements Value<DictType> {
	readonly type: DictType;
	readonly pairs: [K, V][] = [];
	#valueInstance?: Ydb.Value;

	constructor(...items: [K, V][]) {
		let keyType: Type = new NullType();
		let valueType: Type = new NullType();

		for (let [k, v] of items) {
			keyType = k.type;
			valueType = v.type;

			this.pairs.push([k, v]);
		}

		this.type = new DictType(keyType, valueType);
	}

	encode(): Ydb.Value {
		if (!this.#valueInstance) {
			let pairs: { key: Ydb.Value, payload: Ydb.Value }[] = [];

			for (let [k, v] of this.pairs) {
				pairs.push({ key: k.encode(), payload: v.encode() });
			}

			this.#valueInstance = create(Ydb.ValueSchema, { pairs });
		}

		return this.#valueInstance;
	}

	[Symbol.iterator](): IterableIterator<[K, V]> {
		let index = 0;

		return {
			next: (): IteratorResult<[K, V]> => {
				if (index < this.pairs.length) {
					return {
						value: this.pairs[index++] as [K, V],
						done: false
					};
				}

				return { value: undefined as any, done: true };
			},
			[Symbol.iterator](): IterableIterator<[K, V]> {
				return this;
			}
		};
	}
}
