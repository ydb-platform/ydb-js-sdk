import { create } from '@bufbuild/protobuf';
import * as Ydb from '@ydbjs/api/value'

import { type Type, TypeKind } from './type.js';
import type { Value } from './value.js';
import { NullType } from './null.js';

export class ListType implements Type {
	readonly item: Type;
	#typeInstance?: Ydb.Type;

	constructor(item: Type) {
		this.item = item;
	}

	get kind(): TypeKind.LIST {
		return TypeKind.LIST;
	}

	encode(): Ydb.Type {
		if (!this.#typeInstance) {
			this.#typeInstance = create(Ydb.TypeSchema, { type: { case: 'listType', value: { item: this.item.encode() } } });
		}

		return this.#typeInstance;
	}
}

export class List<T extends Value = Value> implements Value<ListType> {
	readonly type: ListType;
	readonly items: T[] = [];
	#valueInstance?: Ydb.Value;

	constructor(...items: T[]) {
		let type: Type = new NullType();

		for (let item of items) {
			type = item.type
			this.items.push(item);
		}

		this.type = new ListType(type);
	}

	encode(): Ydb.Value {
		if (!this.#valueInstance) {
			this.#valueInstance = create(Ydb.ValueSchema, { items: this.items.map(item => item.encode()) });
		}

		return this.#valueInstance;
	}

	*[Symbol.iterator](): Iterator<T> {
		for (let i = 0; i < this.items.length; i++) {
			yield this.items[i]!;
		}
	}
}
