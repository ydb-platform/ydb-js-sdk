import { isUint8Array } from 'node:util/types'
import { type DescMessage, ScalarType, create } from '@bufbuild/protobuf'
import { type ReflectMessage, reflect } from '@bufbuild/protobuf/reflect'
import { type TypedValue, TypedValueSchema, type Type as WireType } from '@ydbjs/api/value'
import { type JSValue, type Value, fromJs } from '@ydbjs/value'

export type QueryParameters = Readonly<Record<string, Value | JSValue>>

/** @internal Borrow validated wire messages for immediate serialization. */
export function encodeParameters(parameters: QueryParameters): Record<string, TypedValue> {
	if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) {
		throw new TypeError('Query parameters must be a named object.')
	}

	let result: Record<string, TypedValue> = Object.create(null)
	let validators = new Map<DescMessage, ReflectMessage>()

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

		let value = fromJs(input)
		let wire = create(TypedValueSchema, { type: value.type.encode(), value: value.encode() })

		assertWireMessage(reflect(TypedValueSchema, wire), validators)
		assertParameterType(wire.type!)

		result[name] = wire
	}

	return result
}

function assertWireMessage(
	source: ReflectMessage,
	validators: Map<DescMessage, ReflectMessage>
): void {
	for (let field of source.fields) {
		if (!source.isSet(field)) {
			continue
		}

		if (field.fieldKind === 'message') {
			assertWireMessage(source.get(field), validators)
		} else if (field.fieldKind === 'list' && field.listKind === 'message') {
			for (let item of source.get(field)) {
				assertWireMessage(item as ReflectMessage, validators)
			}
		} else {
			let value = source.get(field)

			// Protobuf's byte check uses instanceof, which rejects views from another realm.
			if (
				field.fieldKind === 'scalar' &&
				field.scalar === ScalarType.BYTES &&
				isUint8Array(value)
			) {
				continue
			}

			let validator = validators.get(source.desc)

			if (!validator) {
				validator = reflect(source.desc)
				validators.set(source.desc, validator)
			}

			// Setters validate scalars; scratch messages never receive the borrowed message graph.
			validator.set(field, value)
		}
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
