import { create, type MessageInitShape } from "@bufbuild/protobuf";
import type { GenMessage } from "@bufbuild/protobuf/codegenv1";
import { NullValue } from "@bufbuild/protobuf/wkt";
import * as Ydb from "@ydbjs/api/value";

import { TypeKind, type Type } from "./type.js";
import type { Value } from "./value.js";

export class OptionalType implements Type {
	readonly itemType: Type;
	#type: MessageInitShape<GenMessage<Ydb.Type>>;
	#typeInstance?: Ydb.Type;

	constructor(itemType: Type) {
		this.itemType = itemType;
		this.#type = { type: { case: "optionalType", value: { item: itemType.encode() } } };
	}

	get kind(): TypeKind.OPTIONAL {
		return TypeKind.OPTIONAL;
	}

	encode(): Ydb.Type {
		if (!this.#typeInstance) {
			this.#typeInstance = create(Ydb.TypeSchema, this.#type);
		}

		return this.#typeInstance;
	}
}

export class Optional<T extends Type> implements Value<OptionalType> {
	readonly type: OptionalType;
	readonly item: Value<T> | null;
	#valueInstance?: Ydb.Value;

	constructor(item: Value<T> | null, itemType?: T) {
		if (!itemType && !item?.type) {
			throw new Error("Missing item type for optional value. Please provide an item type. Or provide an item with a type.");
		}

		this.item = item;
		this.type = new OptionalType((item?.type || itemType) as Type);
	}

	encode(): Ydb.Value {
		if (!this.#valueInstance) {
			this.#valueInstance = create(Ydb.ValueSchema, this.item !== null ? this.item.encode() : { value: { case: "nullFlagValue", value: NullValue.NULL_VALUE } });
		}

		return this.#valueInstance;
	}
}
