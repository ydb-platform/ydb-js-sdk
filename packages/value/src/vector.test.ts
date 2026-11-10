import { fromBinary, toBinary } from '@bufbuild/protobuf'
import * as Ydb from '@ydbjs/api/value'
import { test } from 'vitest'

import { Bytes, BytesType } from './primitive.js'
import { BitVector, Float32Vector, Int8Vector, Uint8Vector } from './vector.js'

test('encodes Float32Vector with the YDB ListSerialization fixture', (t) => {
	let expected = Buffer.from('mpmZPzMzE0CamVlAAACQQDMzs0AB', 'base64')
	let source = new Float64Array([99, 1.2, 2.3, 3.4, 4.5, 5.6, 99]).subarray(1, -1)
	let vector = new Float32Vector(source)

	t.expect(vector.value).toEqual(new Uint8Array(expected))
	t.expect(vector.dimension).toBe(5)
	t.expect(vector.toTypedArray()).toEqual(new Float32Array(source))
	t.expect(vector.type).toBeInstanceOf(BytesType)
	t.expect(vector.type.encode().type).toEqual({
		case: 'typeId',
		value: Ydb.Type_PrimitiveTypeId.STRING,
	})
	let wire = fromBinary(Ydb.ValueSchema, toBinary(Ydb.ValueSchema, vector.encode()))
	t.expect(wire.value).toEqual({ case: 'bytesValue', value: vector.value })
})

test('encodes Float32Array subviews and readonly arrays without retaining their coordinates', (t) => {
	let source = new Float32Array([99, -0, 1.5, -2.5, 99]).subarray(1, -1)
	let readonly: readonly number[] = [-0, 1.5, -2.5]
	let vector = new Float32Vector(source)
	t.expect(vector.value).toEqual(new Float32Vector(readonly).value)
	t.expect(Object.is(vector.toTypedArray()[0], -0)).toBe(true)
	source.fill(12)
	t.expect(vector.toTypedArray()).toEqual(new Float32Array(readonly))
})

test('encodes integer vectors with YDB Int8Serialization and Uint8Serialization fixtures', (t) => {
	let source = [1, 2, 3, 4, 5]
	t.expect(new Int8Vector(source).value).toEqual(new Uint8Array([1, 2, 3, 4, 5, 3]))
	t.expect(new Uint8Vector(source).value).toEqual(new Uint8Array([1, 2, 3, 4, 5, 2]))

	let signed = new Int8Vector(new Int8Array([12, -128, -1, 0, 127, 12]).subarray(1, -1))
	t.expect(signed.value).toEqual(new Uint8Array([128, 255, 0, 127, 3]))
	t.expect(signed.dimension).toBe(4)
	t.expect(signed.toTypedArray()).toEqual(new Int8Array([-128, -1, 0, 127]))

	let unsigned = new Uint8Vector(new Float64Array([12, 0, 128, 255, 12]).subarray(1, -1))
	t.expect(unsigned.value).toEqual(new Uint8Array([0, 128, 255, 2]))
	t.expect(unsigned.dimension).toBe(3)
	t.expect(unsigned.toTypedArray()).toEqual(new Uint8Array([0, 128, 255]))
})

test('encodes BitVector with the YDB BitSerialization fixtures', (t) => {
	// ydb/library/yql/udfs/common/knn/test/cases/BitSerialization.sql
	let fixtures = [
		{ coordinates: [-1], bytes: [0, 7, 10] },
		{ coordinates: [1, 1], bytes: [3, 6, 10] },
		{ coordinates: [1, 2, 3, 0, -1, -3, 0, 15], bytes: [225, 0, 10] },
		{
			coordinates: [1, 2, 3, 0, -1, -3, 0, 15, 6, -1, -1, 33.34],
			bytes: [25, 14, 4, 10],
		},
		{
			coordinates: [1, 1, -1, -1, -1, -1, -1, 1, 1, -1, -1, 1, 1, -1, -1, 1, 1, -1, 1],
			bytes: [205, 12, 6, 5, 10],
		},
	]
	for (let { coordinates, bytes } of fixtures) {
		let bits = coordinates.map((coordinate) => {
			return Number(coordinate > 0)
		})
		let vector = BitVector.fromSigns(coordinates)
		t.expect(vector.value).toEqual(new Uint8Array(bytes))
		t.expect(new BitVector(bits).value).toEqual(vector.value)
		t.expect(vector.dimension).toBe(coordinates.length)
		t.expect(vector.toTypedArray()).toEqual(new Uint8Array(bits))
		t.expect(BitVector.fromBytes(new Uint8Array(bytes)).toTypedArray()).toEqual(
			new Uint8Array(bits)
		)
	}
})

test('preserves bit order across full 64-bit blocks and a partial tail', (t) => {
	let source = new Uint8Array(129)
	for (let index of [0, 63, 64, 127, 128]) {
		source[index] = 1
	}
	let vector = new BitVector(source)
	t.expect(vector.value).toEqual(
		new Uint8Array([1, 0, 0, 0, 0, 0, 0, 128, 1, 0, 0, 0, 0, 0, 0, 128, 1, 7, 10])
	)
	t.expect(vector.toTypedArray()).toEqual(source)
	for (let index = 0; index < source.length; index++) {
		t.expect(vector.at(index)).toBe(source[index])
		t.expect(vector.at(index - source.length)).toBe(source[index])
	}
})

test('supports every partial-byte and 64-bit boundary', (t) => {
	for (let dimension = 1; dimension <= 130; dimension++) {
		let source = new Uint8Array(dimension)
		for (let index = 0; index < dimension; index++) {
			source[index] = Number(index % 3 === 0)
		}
		let vector = new BitVector(source)
		t.expect(vector.value.length).toBe(Math.ceil(dimension / 8) + 2)
		t.expect(BitVector.fromBytes(vector.value).dimension).toBe(dimension)
		t.expect(BitVector.fromBytes(vector.value).toTypedArray()).toEqual(source)
	}
})

test('uses TypedArray.at index semantics for bit access', (t) => {
	let source = new Uint8Array([0, 1, 1, 0])
	let vector = new BitVector(source)
	for (let index of [-Infinity, -5, -4, -1, -0.5, 0, 1.5, 3, 4, Infinity, NaN]) {
		t.expect(vector.at(index)).toBe(source.at(index))
	}
})

test('borrows packed byte subviews and returns owned numeric projections', (t) => {
	for (let Vector of [Float32Vector, Int8Vector, Uint8Vector, BitVector]) {
		let original = new Vector([0, 1, 1])
		let storage = Buffer.alloc(original.value.length + 2, 99)
		storage.set(original.value, 1)
		let bytes = storage.subarray(1, -1)
		let vector = Vector.fromBytes(bytes)
		t.expect(vector.value).toBe(bytes)
		t.expect(new Vector(new Bytes(bytes)).value).toBe(bytes)
		t.expect(vector.encode().value).toEqual({ case: 'bytesValue', value: bytes })
		let coordinates = vector.toTypedArray()
		t.expect([...coordinates]).toEqual([0, 1, 1])
		coordinates.fill(7)
		t.expect(vector.value).toEqual(bytes)
		t.expect([...vector.toTypedArray()]).toEqual([0, 1, 1])
	}
})

test('decodes numeric vectors directly from unaligned binary input', (t) => {
	for (let Vector of [Float32Vector, Int8Vector, Uint8Vector]) {
		let bytes = new Vector([1, 2, 3]).value
		let storage = Buffer.alloc(bytes.length + 1)
		storage.set(bytes, 1)
		let view = storage.subarray(1)
		let decoded = Vector.decode(view)
		t.expect([...decoded]).toEqual([1, 2, 3])
		decoded.fill(0)
		t.expect(view).toEqual(Buffer.from(bytes))
	}
})

test('copies coordinate input for every vector format', (t) => {
	for (let Vector of [Float32Vector, Int8Vector, Uint8Vector, BitVector]) {
		let source = new Uint8Array([0, 1, 1])
		let vector = new Vector(source)
		source.fill(0)
		t.expect([...vector.toTypedArray()]).toEqual([0, 1, 1])
	}
})

test('rejects invalid array-like lengths', (t) => {
	for (let Vector of [Float32Vector, Int8Vector, Uint8Vector, BitVector]) {
		for (let source of [{ length: -1 }, { length: 1.5 }, { length: Infinity }]) {
			t.expect(() => {
				return new Vector(source as never)
			}).toThrow(/non-negative integer length/)
		}
		for (let source of [null, undefined, '123', 5]) {
			t.expect(() => {
				return new Vector(source as never)
			}).toThrow(TypeError)
		}
		t.expect(() => {
			return Vector.fromBytes(new Uint8Array())
		}).toThrow(/invalid payload/)
	}
	t.expect(() => {
		return BitVector.fromSigns([])
	}).toThrow(/non-empty vector/)
})

test('rejects non-numeric coordinates and non-finite integer or bit coordinates', (t) => {
	for (let Vector of [Float32Vector, Int8Vector, Uint8Vector, BitVector]) {
		for (let coordinate of ['1', true, null, undefined, 1n]) {
			t.expect(() => {
				return new Vector([coordinate] as never)
			}).toThrow(TypeError)
		}
	}
	for (let Vector of [Int8Vector, Uint8Vector, BitVector]) {
		for (let coordinate of [NaN, Infinity, -Infinity]) {
			t.expect(() => {
				return new Vector([coordinate])
			}).toThrow(/must be finite/)
		}
	}
	for (let coordinate of [NaN, Infinity, -Infinity]) {
		t.expect(() => {
			return BitVector.fromSigns([coordinate])
		}).toThrow(/must be finite/)
	}
})

test('rejects Float32 overflow and preserves representable rounded values', (t) => {
	for (let coordinate of [Number.MAX_VALUE, -Number.MAX_VALUE, 3.403e38, -3.403e38]) {
		t.expect(() => {
			return new Float32Vector([coordinate])
		}).toThrow(/outside the Float32 range/)
	}
	let vector = new Float32Vector([3.4028234663852886e38, -3.4028234663852886e38, 16777217])
	t.expect(vector.toTypedArray()).toEqual(
		new Float32Array([3.4028234663852886e38, -3.4028234663852886e38, 16777216])
	)
})

test('rejects integer overflow, truncation and implicit bit sign conversion', (t) => {
	for (let coordinate of [-129, 128, 0.5, -0.5]) {
		t.expect(() => {
			return new Int8Vector([coordinate])
		}).toThrow(/must be an integer in/)
	}
	for (let coordinate of [-1, 256, 0.5]) {
		t.expect(() => {
			return new Uint8Vector([coordinate])
		}).toThrow(/must be an integer in/)
	}
	for (let coordinate of [-1, 2, 0.5]) {
		t.expect(() => {
			return new BitVector([coordinate])
		}).toThrow(/must be 0 or 1/)
	}
	t.expect(BitVector.fromSigns([-1, -0, 0, 0.5, 2]).toTypedArray()).toEqual(
		new Uint8Array([0, 0, 0, 1, 1])
	)
})

test('rejects malformed numeric vector bytes', (t) => {
	for (let Vector of [Float32Vector, Int8Vector, Uint8Vector]) {
		let bytes = new Vector([1]).value
		bytes[bytes.length - 1] = 255
		t.expect(() => {
			return Vector.fromBytes(bytes)
		}).toThrow(/format marker/)
		t.expect(() => {
			return Vector.decode(bytes)
		}).toThrow(/format marker/)
		t.expect(() => {
			return Vector.fromBytes([1, 2, 3] as never)
		}).toThrow(TypeError)
	}
	for (let bytes of [
		[0, 1],
		[0, 0, 0, 0, 0, 1],
	]) {
		t.expect(() => {
			return Float32Vector.fromBytes(new Uint8Array(bytes))
		}).toThrow(/payload/)
	}
})

test('rejects malformed bit payloads, unused counts, markers and padding', (t) => {
	t.expect(() => {
		return BitVector.fromBytes(new Uint8Array([0, 10]))
	}).toThrow(/empty payload/)
	t.expect(() => {
		return BitVector.fromBytes(new Uint8Array([0, 8, 10]))
	}).toThrow(/unused bit count/)
	t.expect(() => {
		return BitVector.fromBytes(new Uint8Array([0, 0, 1]))
	}).toThrow(/format marker/)
	t.expect(() => {
		return BitVector.fromBytes(new Uint8Array([128, 7, 10]))
	}).toThrow(/padding bits/)
	t.expect(() => {
		return BitVector.fromBytes(new Uint8Array([255, 2, 7, 10]))
	}).toThrow(/padding bits/)
	t.expect(BitVector.fromBytes(new Uint8Array([255, 1, 7, 10])).toTypedArray()).toEqual(
		new Uint8Array(9).fill(1)
	)
})

test('preserves empty numeric vectors and IEEE754 Float32 coordinates', (t) => {
	for (let Vector of [Float32Vector, Int8Vector, Uint8Vector]) {
		let vector = new Vector([])

		t.expect(vector.dimension).toBe(0)
		t.expect(vector.value).toHaveLength(1)
		t.expect(Vector.fromBytes(vector.value).toTypedArray()).toHaveLength(0)
	}

	let values = new Float32Array([NaN, Infinity, -Infinity, -0])
	let vector = new Float32Vector(values)

	t.expect(vector.toTypedArray()).toEqual(values)
	t.expect(Float32Vector.fromBytes(vector.value).toTypedArray()).toEqual(values)
})
