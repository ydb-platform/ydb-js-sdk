import { create } from "@bufbuild/protobuf";
import * as wkt from "@bufbuild/protobuf/wkt";
import * as Ydb from "@ydbjs/api/value";

import { type Type, TypeKind } from "./type.js";
import type { Value } from "./value.js";

export class NullType implements Type {
	#typeInstance?: Ydb.Type;

	constructor() {
		if (NullType.instance) {
			return NullType.instance;
		}

		NullType.instance = this;
	}

	private static instance: NullType;

	get kind(): TypeKind.NULL {
		return TypeKind.NULL;
	}

	encode(): Ydb.Type {
		if (!this.#typeInstance) {
			this.#typeInstance = create(Ydb.TypeSchema, { type: { case: "nullType", value: wkt.NullValue.NULL_VALUE } });
		}

		return this.#typeInstance;
	}
}

export class Null implements Value<NullType> {
	readonly type: NullType = new NullType();
	#valueInstance?: Ydb.Value;

	constructor() {
		if (Null.instance) {
			return Null.instance;
		}

		Null.instance = this;
	}

	private static instance: Null;

	encode(): Ydb.Value {
		if (!this.#valueInstance) {
			this.#valueInstance = create(Ydb.ValueSchema, { value: { case: "nullFlagValue", value: wkt.NullValue.NULL_VALUE } });
		}

		return this.#valueInstance;
	}
}
