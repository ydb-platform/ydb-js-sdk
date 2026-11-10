import { isUint8Array } from 'node:util/types'

import { Bytes } from './primitive.js'

function coordinateCount(values: ArrayLike<number>, name: string): number {
	if (typeof values !== 'object' || values === null) {
		throw new TypeError(`${name} requires an array-like object of numbers`)
	}
	let length = values.length
	if (!Number.isSafeInteger(length) || length < 0) {
		throw new RangeError(`${name} requires a non-negative integer length`)
	}
	return length
}

function finiteCoordinate(value: number, index: number, name: string): number {
	if (typeof value !== 'number') {
		throw new TypeError(`${name} coordinate ${index} must be a number`)
	}
	if (!Number.isFinite(value)) {
		throw new RangeError(`${name} coordinate ${index} must be finite`)
	}
	return value
}

function packedBytes(value: unknown, marker: number, width: number, name: string): Uint8Array {
	if (!isUint8Array(value)) {
		throw new TypeError(`${name} bytes must be a Uint8Array`)
	}

	if (value.length < 1 || (value.length - 1) % width !== 0) {
		throw new RangeError(`${name} bytes have an invalid payload`)
	}
	if (value[value.length - 1] !== marker) {
		throw new RangeError(`${name} bytes have an invalid format marker`)
	}
	return value
}

function packFloats(values: ArrayLike<number>): Uint8Array {
	let dimension = coordinateCount(values, 'Float32Vector')
	let bytes = new Uint8Array(dimension * 4 + 1)
	let view = new DataView(bytes.buffer)
	for (let index = 0; index < dimension; index++) {
		let value = values[index]!
		if (typeof value !== 'number') {
			throw new TypeError(`Float32Vector coordinate ${index} must be a number`)
		}
		let rounded = Math.fround(value)
		if (Number.isFinite(value) && !Number.isFinite(rounded)) {
			throw new RangeError(`Float32Vector coordinate ${index} is outside the Float32 range`)
		}
		view.setFloat32(index * 4, rounded, true)
	}
	bytes[bytes.length - 1] = 1
	return bytes
}

function packIntegers(values: ArrayLike<number>, signed: boolean): Uint8Array {
	let name = signed ? 'Int8Vector' : 'Uint8Vector'
	let dimension = coordinateCount(values, name)
	let bytes = new Uint8Array(dimension + 1)
	let min = signed ? -128 : 0
	let max = signed ? 127 : 255
	for (let index = 0; index < dimension; index++) {
		let value = finiteCoordinate(values[index]!, index, name)
		if (!Number.isInteger(value) || value < min || value > max) {
			throw new RangeError(
				`${name} coordinate ${index} must be an integer in [${min}, ${max}]`
			)
		}
		bytes[index] = value
	}
	bytes[dimension] = signed ? 3 : 2
	return bytes
}

function bitBytes(value: unknown): Uint8Array {
	let bytes = packedBytes(value, 10, 1, 'BitVector')
	if (bytes.length < 3) {
		throw new RangeError('BitVector bytes have an empty payload')
	}

	let unused = bytes[bytes.length - 2]!

	if (unused > 7) {
		throw new RangeError('BitVector bytes have an invalid unused bit count')
	}

	if (bytes[bytes.length - 3]! >> (8 - unused)) {
		throw new RangeError('BitVector bytes have non-zero padding bits')
	}
	return bytes
}

function packBits(values: ArrayLike<number>, fromSigns: boolean): Uint8Array {
	let dimension = coordinateCount(values, 'BitVector')
	if (dimension === 0) {
		throw new RangeError('BitVector requires a non-empty vector')
	}

	let bytes = new Uint8Array(Math.ceil(dimension / 8) + 2)
	// YDB knn-serializer-shared.h writes each 64-bit accumulator and its tail little-endian.
	for (let start = 0; start < dimension; start += 64) {
		let length = Math.min(64, dimension - start)
		for (let index = 0; index < length; index++) {
			let value = finiteCoordinate(values[start + index]!, start + index, 'BitVector')
			if (!fromSigns && value !== 0 && value !== 1) {
				throw new RangeError(`BitVector coordinate ${start + index} must be 0 or 1`)
			}
			if (value > 0) {
				let bit = length - index - 1
				bytes[start / 8 + Math.floor(bit / 8)]! |= 1 << (bit % 8)
			}
		}
	}
	bytes[bytes.length - 2] = (8 - (dimension % 8)) % 8
	bytes[bytes.length - 1] = 10
	return bytes
}

export class Float32Vector extends Bytes {
	declare readonly value: Uint8Array

	constructor(values: ArrayLike<number> | Bytes) {
		super(
			values instanceof Bytes
				? packedBytes(values.value, 1, 4, 'Float32Vector')
				: packFloats(values)
		)
	}

	get dimension(): number {
		return (this.value.length - 1) / 4
	}

	/** Borrows the packed bytes; the caller must keep them immutable. */
	static fromBytes(bytes: Uint8Array): Float32Vector {
		return new Float32Vector(new Bytes(bytes))
	}

	static decode(bytes: Uint8Array): Float32Array {
		bytes = packedBytes(bytes, 1, 4, 'Float32Vector')
		let values = new Float32Array((bytes.length - 1) / 4)
		let view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length - 1)
		for (let index = 0; index < values.length; index++) {
			values[index] = view.getFloat32(index * 4, true)
		}
		return values
	}

	toTypedArray(): Float32Array {
		return Float32Vector.decode(this.value)
	}
}

export class Int8Vector extends Bytes {
	declare readonly value: Uint8Array

	constructor(values: ArrayLike<number> | Bytes) {
		super(
			values instanceof Bytes
				? packedBytes(values.value, 3, 1, 'Int8Vector')
				: packIntegers(values, true)
		)
	}

	get dimension(): number {
		return this.value.length - 1
	}

	/** Borrows the packed bytes; the caller must keep them immutable. */
	static fromBytes(bytes: Uint8Array): Int8Vector {
		return new Int8Vector(new Bytes(bytes))
	}

	static decode(bytes: Uint8Array): Int8Array {
		bytes = packedBytes(bytes, 3, 1, 'Int8Vector')
		return new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length - 1).slice()
	}

	toTypedArray(): Int8Array {
		return Int8Vector.decode(this.value)
	}
}

export class Uint8Vector extends Bytes {
	declare readonly value: Uint8Array

	constructor(values: ArrayLike<number> | Bytes) {
		super(
			values instanceof Bytes
				? packedBytes(values.value, 2, 1, 'Uint8Vector')
				: packIntegers(values, false)
		)
	}

	get dimension(): number {
		return this.value.length - 1
	}

	/** Borrows the packed bytes; the caller must keep them immutable. */
	static fromBytes(bytes: Uint8Array): Uint8Vector {
		return new Uint8Vector(new Bytes(bytes))
	}

	static decode(bytes: Uint8Array): Uint8Array {
		bytes = packedBytes(bytes, 2, 1, 'Uint8Vector')
		return new Uint8Array(bytes.subarray(0, -1))
	}

	toTypedArray(): Uint8Array {
		return Uint8Vector.decode(this.value)
	}
}

export class BitVector extends Bytes {
	declare readonly value: Uint8Array

	constructor(values: ArrayLike<number> | Bytes) {
		super(values instanceof Bytes ? bitBytes(values.value) : packBits(values, false))
	}

	get dimension(): number {
		return (this.value.length - 2) * 8 - this.value[this.value.length - 2]!
	}

	/** Borrows the packed bytes; the caller must keep them immutable. */
	static fromBytes(bytes: Uint8Array): BitVector {
		return new BitVector(new Bytes(bytes))
	}

	/** Maps finite coordinates to 1 when positive and 0 otherwise, like Knn::ToBinaryStringBit. */
	static fromSigns(values: ArrayLike<number>): BitVector {
		return BitVector.fromBytes(packBits(values, true))
	}

	at(index: number): 0 | 1 | undefined {
		index = Math.trunc(index) || 0
		let dimension = this.dimension

		if (index < 0) {
			index += dimension
		}

		if (index < 0 || index >= dimension) {
			return undefined
		}

		let start = Math.floor(index / 64) * 64
		let bit = Math.min(64, dimension - start) - (index - start) - 1
		return ((this.value[start / 8 + Math.floor(bit / 8)]! >> (bit % 8)) & 1) as 0 | 1
	}

	toTypedArray(): Uint8Array {
		let dimension = this.dimension
		let values = new Uint8Array(dimension)
		for (let start = 0; start < dimension; start += 64) {
			let length = Math.min(64, dimension - start)
			for (let index = 0; index < length; index++) {
				let bit = length - index - 1
				values[start + index] =
					(this.value[start / 8 + Math.floor(bit / 8)]! >> (bit % 8)) & 1
			}
		}
		return values
	}
}
