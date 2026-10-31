import { clone, create } from '@bufbuild/protobuf'
import {
	type TypedValue,
	TypedValueSchema,
	type Type as WireType,
	type Value as WireValue,
} from '@ydbjs/api/value'
import { type JSValue, type Type, type TypeKind, type Value, fromJs } from '@ydbjs/value'

import { Optional, OptionalType } from '@ydbjs/value/optional'
import { Variant, VariantType } from '@ydbjs/value/variant'
import { Tagged } from '@ydbjs/value/tagged'
import { List } from '@ydbjs/value/list'
import { Tuple } from '@ydbjs/value/tuple'
import { Struct } from '@ydbjs/value/struct'
import { Dict } from '@ydbjs/value/dict'

export type QueryParameters = Readonly<Record<string, Value | JSValue>>

class BoundValue implements Value {
	readonly type: Type
	readonly snapshot: TypedValue

	constructor(snapshot: TypedValue, kind: TypeKind) {
		this.snapshot = snapshot
		this.type = { kind, encode: () => snapshot.type! }
	}

	encode(): WireValue {
		return this.snapshot.value!
	}
}

export function encodeParameters(parameters: QueryParameters): Record<string, TypedValue> {
	if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters))
		throw new TypeError('Query parameters must be a named object.')
	let encoded: Record<string, TypedValue> = Object.create(null)
	for (let [key, input] of Object.entries(parameters)) {
		let name = key.startsWith('$') ? key : '$' + key
		if (!/^\$[A-Za-z_][A-Za-z_0-9]*$/.test(name))
			throw new TypeError(`Invalid query parameter name: ${key}`)
		if (name in encoded) throw new TypeError(`Duplicate query parameter: ${name}`)
		if (input === undefined) throw new TypeError(`Query parameter ${name} is undefined.`)
		if (input instanceof BoundValue) {
			// Tagged bindings already own detached wire values for the whole retry operation.
			encoded[name] = input.snapshot
			continue
		}
		let value =
			input !== null &&
			typeof input === 'object' &&
			'encode' in input &&
			typeof input.encode === 'function'
				? (input as Value)
				: fromJs(input as JSValue)
		assertParameterValue(value)
		let snapshot = clone(
			TypedValueSchema,
			create(TypedValueSchema, {
				type: value.type.encode(),
				value: value.encode(),
			})
		)
		assertParameterType(snapshot.type!)
		copyBuffers(snapshot.value!)
		encoded[name] = snapshot
	}
	return encoded
}

export function bindParameters(parameters: Readonly<Record<string, Value>>): Record<string, Value> {
	let bound: Record<string, Value> = Object.create(null)
	for (let [name, snapshot] of Object.entries(encodeParameters(parameters))) {
		let original = parameters[name] ?? parameters[name.slice(1)]!
		bound[name] = new BoundValue(snapshot, original.type.kind)
	}
	return bound
}

function copyBuffers(value: WireValue): void {
	// Protobuf clone uses .slice(); Buffer overrides it with a shared-memory view.
	if (value.value.case === 'bytesValue' && Buffer.isBuffer(value.value.value))
		value.value.value = new Uint8Array(value.value.value)
	if (value.value.case === 'nestedValue') copyBuffers(value.value.value)
	for (let item of value.items) copyBuffers(item)
	for (let pair of value.pairs) {
		if (pair.key) copyBuffers(pair.key)
		if (pair.payload) copyBuffers(pair.payload)
	}
}

function assertParameterType(type: WireType): void {
	switch (type.type.case) {
		case 'taggedType':
			throw new TypeError(
				'YDB does not accept Tagged query parameters; unwrap the value and apply AsTagged in the query'
			)
		case 'optionalType':
		case 'listType':
			assertParameterType(type.type.value.item!)
			break
		case 'dictType':
			assertParameterType(type.type.value.key!)
			assertParameterType(type.type.value.payload!)
			break
		case 'tupleType':
			for (let item of type.type.value.elements) assertParameterType(item)
			break
		case 'structType':
			for (let item of type.type.value.members) assertParameterType(item.type!)
			break
		case 'variantType': {
			let items = type.type.value.type
			if (items.case === 'tupleItems')
				for (let item of items.value.elements) assertParameterType(item)
			if (items.case === 'structItems')
				for (let item of items.value.members) assertParameterType(item.type!)
		}
	}
}

function assertParameterValue(value: Value): void {
	if (value instanceof Optional && value.item === null) {
		let type = value.type.itemType
		while (type instanceof OptionalType) type = type.itemType
		if (type instanceof VariantType)
			throw new TypeError(
				'YDB cannot import an absent Optional<Variant> parameter; construct the absence in the query'
			)
	}
	if (
		(value instanceof Optional || value instanceof Variant || value instanceof Tagged) &&
		value.item
	)
		assertParameterValue(value.item)
	if (value instanceof List || value instanceof Tuple || value instanceof Struct)
		for (let item of value.items) assertParameterValue(item)
	if (value instanceof Dict)
		for (let [key, item] of value.pairs) {
			assertParameterValue(key)
			assertParameterValue(item)
		}
}
