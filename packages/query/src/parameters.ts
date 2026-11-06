import { isUint8Array } from 'node:util/types'
import { create } from '@bufbuild/protobuf'
import { type ReflectMessage, isReflectMessage, reflect } from '@bufbuild/protobuf/reflect'
import {
	type TypedValue,
	TypedValueSchema,
	type Type as WireType,
	type Value as WireValue,
} from '@ydbjs/api/value'
import { type JSValue, type Type, type Value, fromJs } from '@ydbjs/value'

export type QueryParameters = Readonly<Record<string, Value | JSValue>>

// An SDK-owned retry must send the original type and bytes even if the caller mutates a Value or Buffer.
class SnapshotValue implements Value {
	readonly type: Type

	constructor(
		readonly wire: TypedValue,
		kind: Type['kind']
	) {
		this.type = {
			kind,
			encode: () => {
				return wire.type!
			},
		}
	}

	encode(): WireValue {
		return this.wire.value!
	}
}

/** @internal Capture one input for a standalone operation before admitting it to the pool. */
export function snapshotValue(input: JSValue): Value {
	let value = fromJs(input)

	return new SnapshotValue(encodeValue(value), value.type.kind)
}

function encodeValue(value: Value): TypedValue {
	let wire = create(TypedValueSchema, { type: value.type.encode(), value: value.encode() })
	let snapshot = copyMessage(reflect(TypedValueSchema, wire)).message as TypedValue

	assertParameterType(snapshot.type!)

	return snapshot
}

export function encodeParameters(parameters: QueryParameters): Record<string, TypedValue> {
	return mapParameters(parameters, (input) => {
		return input instanceof SnapshotValue ? input.wire : encodeValue(fromJs(input))
	})
}

export function snapshotInputs(parameters: QueryParameters): Record<string, Value> {
	return mapParameters(parameters, snapshotValue)
}

function mapParameters<T>(
	parameters: QueryParameters,
	convert: (input: JSValue) => T
): Record<string, T> {
	if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) {
		throw new TypeError('Query parameters must be a named object.')
	}

	let result: Record<string, T> = Object.create(null)

	for (let [key, input] of Object.entries(parameters)) {
		let name = key.startsWith('$') ? key : '$' + key

		if (!/^\$[A-Za-z_][A-Za-z_0-9]*$/.test(name)) {
			throw new TypeError(`Invalid query parameter name: ${key}`)
		}

		if (name in result) {
			throw new TypeError(`Duplicate query parameter: ${name}`)
		}

		if (input === undefined) {
			throw new TypeError(`Query parameter ${name} is undefined.`)
		}

		result[name] = convert(input)
	}

	return result
}

function copyFieldValue(value: unknown): unknown {
	if (isReflectMessage(value)) {
		return copyMessage(value)
	}

	return isUint8Array(value) ? new Uint8Array(value) : value
}

// Reflection validates field assignments while copying only the bytes visible through each view.
// Protobuf clone() shares unknown fields and uses .slice() on Buffer, which shares its storage.
function copyMessage(source: ReflectMessage): ReflectMessage {
	let target = reflect(source.desc)

	for (let field of source.fields) {
		if (!source.isSet(field)) {
			continue
		}

		if (field.fieldKind === 'list') {
			let list = target.get(field)

			for (let item of source.get(field)) {
				list.add(copyFieldValue(item))
			}
		} else if (field.fieldKind === 'map') {
			let map = target.get(field)

			for (let [key, item] of source.get(field)) {
				map.set(key, copyFieldValue(item))
			}
		} else {
			target.set(field, copyFieldValue(source.get(field)))
		}
	}

	let unknown = source.getUnknown()

	if (unknown?.length) {
		target.setUnknown(
			unknown.map(({ no, wireType, data }) => {
				return { no, wireType, data: new Uint8Array(data) }
			})
		)
	}

	return target
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
			for (let item of type.type.value.elements) {
				assertParameterType(item)
			}
			break
		case 'structType':
			for (let item of type.type.value.members) {
				assertParameterType(item.type!)
			}
			break
		case 'variantType':
			throw new TypeError(
				'Variant query parameters are not supported; read Variant results in raw mode'
			)
	}
}
