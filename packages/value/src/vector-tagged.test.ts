import { expect, test } from 'vitest'

import { fromJs, fromYdb, toJs } from './index.js'
import { List } from './list.js'
import { Optional } from './optional.js'
import { Bytes, Int32 } from './primitive.js'
import { Struct } from './struct.js'
import { Tagged } from './tagged.js'
import { BitVector, Float32Vector, Int8Vector, Uint8Vector } from './vector.js'

test('projects standard numeric vector tags while preserving the decoded wire type', () => {
	let cases = [
		{
			tag: 'FloatVector',
			value: new Float32Vector([1.5, -2]),
			expected: new Float32Array([1.5, -2]),
		},
		{
			tag: 'Int8Vector',
			value: new Int8Vector([-128, 127]),
			expected: new Int8Array([-128, 127]),
		},
		{
			tag: 'Uint8Vector',
			value: new Uint8Vector([0, 255]),
			expected: new Uint8Array([0, 255]),
		},
	]

	for (let { tag, value, expected } of cases) {
		let original = new Tagged(value, tag)
		let wireType = original.type.encode()
		let wireValue = original.encode()
		let decoded = fromYdb(wireValue, wireType)

		expect(toJs(decoded)).toEqual(expected)
		expect(decoded).toBeInstanceOf(Tagged)
		expect(decoded.type.encode()).toEqual(wireType)
		expect(decoded.encode()).toEqual(wireValue)
	}
})

test('keeps tagged bit vectors compact', () => {
	let bits = new BitVector([1, 0, 1])
	let tagged = new Tagged(bits, 'BitVector')

	let result = toJs(fromYdb(tagged.encode(), tagged.type.encode())) as BitVector

	expect(result).toBeInstanceOf(BitVector)
	expect(result.dimension).toBe(3)
	expect(result.toTypedArray()).toEqual(new Uint8Array([1, 0, 1]))
})

test('projects vector tags recursively through containers', () => {
	let vector = new Tagged(new Float32Vector([1, 2]), 'FloatVector')
	let value = new Struct({ embeddings: new List(new Optional(vector)) })

	let result = toJs(fromYdb(value.encode(), value.type.encode()))

	expect(result).toEqual({ embeddings: [new Float32Array([1, 2])] })
})

test('retains ordinary binary values, unknown tags and tags on other types', () => {
	let bytes = new Bytes(new Float32Vector([1, 2]).value)
	let unknown = new Tagged(bytes, 'application/data')
	let otherType = new Tagged(new Int32(42), 'FloatVector')

	expect(toJs(bytes)).toBe(bytes.value)
	expect(toJs(unknown)).toBe(unknown)
	expect(toJs(otherType)).toBe(otherType)
})

test('rejects a malformed payload for a recognized vector tag', () => {
	let value = new Tagged(new Bytes(Uint8Array.of(0, 1)), 'FloatVector')

	expect(() => {
		return toJs(value)
	}).toThrow(/Float32Vector/)
})

test('keeps native typed arrays distinct from explicit packed vectors', () => {
	let floats = new Float32Array([1, 2])
	let signed = new Int8Array([-1, 2])
	let bytes = new Uint8Array([1, 2])
	let vector = new Float32Vector(floats)

	expect(fromJs(floats)).toBeInstanceOf(List)
	expect(toJs(fromJs(signed))).toEqual([-1, 2])
	expect(fromJs(bytes)).toBeInstanceOf(Bytes)
	expect(fromJs(vector)).toBe(vector)
})
