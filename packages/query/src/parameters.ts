import { clone, create } from '@bufbuild/protobuf'
import {
	type TypedValue,
	TypedValueSchema,
	type Type as WireType,
	type Value as WireValue,
} from '@ydbjs/api/value'
import { type JSValue, type Type, type TypeKind, type Value, fromJs } from '@ydbjs/value'

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
		case 'variantType':
			throw new TypeError(
				'Variant query parameters are not supported; read Variant results in raw mode'
			)
	}
}
