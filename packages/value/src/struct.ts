import { create } from '@bufbuild/protobuf';
import * as Ydb from '@ydbjs/api/value'

import { TypeKind, type Type } from "./type.js";
import type { Value } from './value.js';

export class StructType implements Type {
	readonly names: string[];
	readonly types: Type[];
	#typeInstance?: Ydb.Type;

	constructor(names: string[], types: Type[]) {
		this.names = names;
		this.types = types;
	}

	get kind(): TypeKind.STRUCT {
		return TypeKind.STRUCT;
	}

	encode(): Ydb.Type {
		if (!this.#typeInstance) {
			let members: { name: string, type: Ydb.Type }[] = []
			for (let i = 0; i < this.names.length; i++) {
				members.push({ name: this.names[i], type: this.types[i].encode() })
			}

			this.#typeInstance = create(Ydb.TypeSchema, { type: { case: 'structType', value: { members } } });
		}

		return this.#typeInstance;
	}
}

export class Struct<T extends Record<string, Value> = Record<string, Value>> implements Value<StructType> {
	readonly type: StructType;
	readonly items: Value[] = [];
	#valueInstance?: Ydb.Value;

	constructor(value: T) {
		let names: string[] = [];
		let types: Type[] = [];

		for (let key in value) {
			names.push(key);
			types.push(value[key].type);
			this.items.push(value[key]);
		}

		this.type = new StructType(names, types);
	}

	encode(): Ydb.Value {
		if (!this.#valueInstance) {
			this.#valueInstance = create(Ydb.ValueSchema, { items: this.items.map(i => i.encode()) });
		}

		return this.#valueInstance;
	}
}
