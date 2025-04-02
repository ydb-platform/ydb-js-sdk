import { create } from '@bufbuild/protobuf';
import * as Ydb from '@ydbjs/api/value';

import { Optional } from './optional.js';
import { TypeKind, type Type } from "./type.js";
import type { Value } from './value.js';

export class StructType implements Type {
	readonly names: string[] = [];
	readonly types: Type[] = [];
	#typeInstance?: Ydb.Type;

	constructor(names: string[], types: Type[], sorted = false) {
		if (sorted) {
			this.names = names;
			this.types = types;

			return
		}

		const indices = names.map((_, i) => i);
		indices.sort((a, b) => names[a].localeCompare(names[b]));

		for (let i of indices) {
			this.names.push(names[i]);
			this.types.push(types[i]);
		}
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

	*[Symbol.iterator](): Iterator<[string, Type]> {
		for (let i = 0; i < this.names.length; i++) {
			yield [this.names[i], this.types[i]];
		}
	}
}

export class Struct<T extends Record<string, Value> = Record<string, Value>> implements Value<StructType> {
	readonly type: StructType;
	readonly items: Value[] = [];
	#valueInstance?: Ydb.Value;

	constructor(obj: T, def?: StructType) {
		if (def) {
			this.type = def;

			for (let [name, type] of def) {
				let value = obj[name]
				if (value && value.type.kind !== type.kind) {
					throw new Error(`Invalid type for ${name}: expected ${type.kind}, got ${value.type.kind}`);
				}

				this.items.push(value ? value : new Optional(null, type));
			}

			return
		}

		let keys = Object.keys(obj)
		let names: string[] = [];
		let types: Type[] = [];

		// Sort both arrays based on names
		const indices = keys.map((_, i) => i);
		indices.sort((a, b) => keys[a].localeCompare(keys[b]));

		for (let i of indices) {
			names.push(keys[i]);
			types.push(obj[keys[i]].type);
			this.items.push(obj[keys[i]]);
		}

		this.type = new StructType(names, types, true);
	}

	encode(): Ydb.Value {
		if (!this.#valueInstance) {
			this.#valueInstance = create(Ydb.ValueSchema, { items: this.items.map(i => i.encode()) });
		}

		return this.#valueInstance;
	}
}
